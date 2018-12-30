'use strict';

// http://theburningmonk.com/2016/08/aws-lambda-janitor-lambda-function-to-clean-up-old-deployment-packages/
const _      = require('lodash');
const co     = require('co');
const AWS    = require('aws-sdk');
const lambda = new AWS.Lambda({ apiVersion: '2015-03-31' });

let functions = [];

let listFunctions = co.wrap(function* () {
  console.log('listing all available functions');

  let loop = co.wrap(function* (marker, acc) {
    let params = {
      Marker: marker,
      MaxItems: 10
    };

    let res = yield lambda.listFunctions(params).promise();
    let functions = res.Functions.map(x => x.FunctionArn);
    let newAcc = acc.concat(functions);

    if (res.NextMarker) {
      return yield loop(res.NextMarker, newAcc);
    } else {
      return _.shuffle(newAcc);
    }
  });

  return yield loop(undefined, []);
});

let listVersions = co.wrap(function* (funcArn) {
  console.log(`listing versions for function : ${funcArn}`);

  let loop = co.wrap(function* (marker, acc) {
    let params = {
      FunctionName: funcArn,
      Marker: marker,
      MaxItems: 20
    };

    let res = yield lambda.listVersionsByFunction(params).promise();
    let versions = res.Versions.map(x => x.Version).filter(x => x != "$LATEST");
    let newAcc = acc.concat(versions);

    if (res.NextMarker) {
      return yield loop(res.NextMarker, newAcc);
    } else {
      return newAcc;
    }
  });

  return yield loop(undefined, []);
});

let listAliasedVersions = co.wrap(function* (funcArn) {
  console.log(`listing aliases for function : ${funcArn}`);

  let loop = co.wrap(function* (marker, acc) {
    let params = {
      FunctionName: funcArn,
      Marker: marker,
      MaxItems: 20
    };

    let res = yield lambda.listAliases(params).promise();
    let versions = res.Aliases.map(x => x.FunctionVersion);
    let newAcc = acc.concat(versions);

    if (res.NextMarker) {
      return yield loop(res.NextMarker, newAcc);
    } else {
      return newAcc;
    }
  });

  return yield loop(undefined, []);
});

let deleteVersion = co.wrap(function* (funcArn, version) {
  console.log(`deleting [${funcArn}] version [${version}]`);

  let params = {
    FunctionName: funcArn,
    Qualifier: version
  };

  let res = yield lambda.deleteFunction(params).promise();
  console.log(res);
});

let cleanFunc = co.wrap(function* (funcArn) {
  if (funcArn.indexOf('civ-serverless') < 0) {
    console.log('skipping arn ' + funcArn);
    return;
  }

  console.log(`cleaning function: ${funcArn}`);
  let aliasedVersions = yield listAliasedVersions(funcArn);
  console.log('found aliased versions:\n', aliasedVersions);

  let versions = yield listVersions(funcArn);
  console.log('found versions:\n', versions);

  for (let version of versions) {
    if (!_.includes(aliasedVersions, version)) {
      yield deleteVersion(funcArn, version);
    }
  }
});

let clean = co.wrap(function* () {
  if (functions.length === 0) {
    functions = yield listFunctions();
  }

  // clone the functions that are left to do so that as we iterate with it we
  // can remove cleaned functions from 'functions'
  let toClean = functions.map(x => x);
  console.log(`${toClean.length} functions to clean:\n`, toClean);

  for (let func of toClean) {
    yield cleanFunc(func);
    _.pull(functions, func);
  }
});

module.exports.clean = clean;
