import { GameTurn, GameTurnKey, Game, User, playerIsHuman } from '../models';
import { IRepository, dynamoose } from './common';
import { Config } from '../config';
import { HttpResponseError } from '../../api/framework/index';
import * as _ from 'lodash';
import * as civ6 from 'civ6-save-parser';
import * as zlib from 'zlib';
import * as pwdgen from 'generate-password';
import * as AWS from 'aws-sdk';
const s3 = new AWS.S3();

export interface IGameTurnRepository extends IRepository<GameTurnKey, GameTurn> {
  createS3SaveKey(gameId: string, turn: number): string;
  getAndUpdateSaveFileForGameState(game: Game, users?: User[]): Promise<any>;
  updateTurnStatistics(game: Game, gameTurn: GameTurn, user: User, undo?: boolean): void;
  updateSaveFileForGameState(game: Game, users?: User[], wrapper?): Promise<any>;
  parseSaveFile(buffer, game: Game);
}

export const gameTurnRepository = dynamoose.createVersionedModel(Config.resourcePrefix() + 'game-turn', {
  gameId: {
    type: String,
    hashKey: true
  },
  turn: {
    type: Number,
    rangeKey: true
  },
  round: {
    type: Number,
    required: true
  },
  playerSteamId: {
    type: String,
    required: true
  },
  startDate: {
    type: Date,
    required: true,
    default: function() {
      return new Date();
    }
  },
  endDate: Date,
  skipped: Boolean
}) as IGameTurnRepository;

gameTurnRepository.createS3SaveKey = (gameId, turn) => {
  return gameId + '/' + ('000000' + turn).slice(-6) + '.CivXSave';
};

gameTurnRepository.getAndUpdateSaveFileForGameState = async (game, users) => {
  const s3Key = gameTurnRepository.createS3SaveKey(game.gameId, game.gameTurnRangeKey);

  const data = await s3.getObject({
    Bucket: Config.resourcePrefix() + 'saves',
    Key: s3Key
  }).promise();

  if (!data && !data.Body) {
    throw new Error(`File doesn't exist: ${s3Key}`);
  }

  return gameTurnRepository.updateSaveFileForGameState(game, users, gameTurnRepository.parseSaveFile(data.Body, game));
};

gameTurnRepository.updateTurnStatistics = (game, gameTurn, user, undo) => {
  const undoInc = undo ? -1 : 1;

  if (gameTurn.endDate) {
    const player = _.find(game.players, p => {
      return p.steamId === user.steamId;
    });

    if (gameTurn.skipped) {
      player.turnsSkipped = (player.turnsSkipped || 0) + 1 * undoInc;
      user.turnsSkipped = (user.turnsSkipped || 0) + 1 * undoInc;
    } else {
      player.turnsPlayed = (player.turnsPlayed || 0) + 1 * undoInc;
      user.turnsPlayed = (user.turnsPlayed || 0) + 1 * undoInc;
    }

    const timeTaken = gameTurn.endDate.getTime() - gameTurn.startDate.getTime();
    player.timeTaken = (player.timeTaken || 0) + timeTaken * undoInc;
    user.timeTaken = (user.timeTaken || 0) + timeTaken * undoInc;

    if (timeTaken < 1000 * 60 * 60) {
      user.fastTurns = (user.fastTurns || 0) + 1 * undoInc;
      player.fastTurns = (player.fastTurns || 0) + 1 * undoInc;
    }

    if (timeTaken > 1000 * 60 * 60 * 6) {
      user.slowTurns = (user.slowTurns || 0) + 1 * undoInc;
      player.slowTurns = (player.slowTurns || 0) + 1 * undoInc;
    }
  }
};

gameTurnRepository.updateSaveFileForGameState = (game, users, wrapper) => {
  const parsed = wrapper.parsed;

  for (let i = parsed.CIVS.length - 1; i >= 0; i--) {
    const parsedCiv = parsed.CIVS[i];

    if (game.players[i]) {
      const player = game.players[i];

      if (!playerIsHuman(player)) {
        // Make sure surrendered players are marked as AI
        if (parsedCiv.ACTOR_AI_HUMAN.data === 3) {
          civ6.modifyChunk(wrapper.chunks, parsedCiv.ACTOR_AI_HUMAN, 1);
        }
      } else {
        let slotHeaderVal = parsedCiv.SLOT_HEADER.data;

        if (parsedCiv.ACTOR_AI_HUMAN.data === 1) {
          civ6.modifyChunk(wrapper.chunks, parsedCiv.ACTOR_AI_HUMAN, 3);
        }

        if (users) {
          const user = _.find(users, u => {
            return u.steamId === player.steamId;
          });

          // Make sure player names are correct
          if (parsedCiv.PLAYER_NAME) {
            if (parsedCiv.PLAYER_NAME.data !== user.displayName) {
              civ6.modifyChunk(wrapper.chunks, parsedCiv.PLAYER_NAME, user.displayName);
            }
          } else {
            civ6.addChunk(
              wrapper.chunks,
              parsedCiv.LEADER_NAME,
              civ6.MARKERS.ACTOR_DATA.PLAYER_NAME,
              civ6.DATA_TYPES.STRING,
              user.displayName
            );

            slotHeaderVal++;
          }
        }

        if (player.steamId === game.currentPlayerSteamId) {
          // Delete any password for the active player
          if (parsedCiv.PLAYER_PASSWORD) {
            civ6.deleteChunk(wrapper.chunks, parsedCiv.PLAYER_PASSWORD);
            slotHeaderVal--;
          }
        } else {
          // Make sure all other players have a random password
          if (!parsedCiv.PLAYER_PASSWORD) {
            civ6.addChunk(
              wrapper.chunks,
              parsedCiv.LEADER_NAME,
              civ6.MARKERS.ACTOR_DATA.PLAYER_PASSWORD,
              civ6.DATA_TYPES.STRING,
              pwdgen.generate({})
            );

            slotHeaderVal++;
          } else {
            civ6.modifyChunk(wrapper.chunks, parsedCiv.PLAYER_PASSWORD, pwdgen.generate({}));
          }
        }

        civ6.modifyChunk(wrapper.chunks, parsedCiv.SLOT_HEADER, slotHeaderVal);
      }
    }
  }

  const saveKey = gameTurnRepository.createS3SaveKey(game.gameId, game.gameTurnRangeKey);
  const uncompressedBody = Buffer.concat(wrapper.chunks);

  return Promise.all([
    s3.putObject({
      Bucket: Config.resourcePrefix() + 'saves',
      Key: saveKey,
      Body: uncompressedBody
    }).promise(),
    s3.putObject({
      Bucket: Config.resourcePrefix() + 'saves',
      Key: saveKey + '.gz',
      Body: zlib.gzipSync(uncompressedBody)
    }).promise()
  ]);
}

gameTurnRepository.parseSaveFile = (buffer, game) => {
  try {
    return civ6.parse(buffer);
  } catch (e) {
    // TODO: Should probably be a non-HTTP specific error type
    throw new HttpResponseError(400, `Could not parse uploaded file!  If you continue to have trouble please post on the PYDT forums.`);
  }
}