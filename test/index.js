'use strict';

/* eslint-env node, mocha */

const assert = require('assert');
const BbPromise = require('bluebird');
const sinon = require('sinon');

const PrunePlugin = require('../');

describe('PrunePlugin', function() {

  function createMockServerless(functions) {
    const serverless = {
      getProvider: sinon.stub(),
      cli: { log: sinon.stub() },
      service: {
        getAllFunctions: () => functions,
        getFunction: (key) => { return { name:`service-${key}` }; },
      }
    };
    const provider = { request: sinon.stub() };
    serverless.getProvider.withArgs('aws').returns(provider);

    return serverless;
  }

  function createAliasResponse(versions) {

    const resp = { };
    resp.Aliases = versions.concat(['$LATEST']).map(v => {
      return {
        FunctionVersion: '' + v,
        Description: `Alias v${v}`
      };
    });

    return Promise.resolve(resp);
  }

  function createVersionsResponse(aliasedVersions) {

    const resp = {};
    resp.Versions = aliasedVersions.map(v => {
      return {
        Version: '' + v,
        Description: `Alias v${v}`
      };
    });

    return Promise.resolve(resp);
  }

  describe('constructor', function() {

    it('should assign correct properties', function() {

      const serverlessStub = { getProvider: sinon.stub() };
      
      const provider = { aws: 'provider' };
      const options = { option: 'a' };
      serverlessStub.getProvider.withArgs('aws').returns(provider);

      const plugin = new PrunePlugin(serverlessStub, options);

      assert.strictEqual(serverlessStub, plugin.serverless);
      assert.strictEqual(options, plugin.options);

      assert(serverlessStub.getProvider.calledOnce);
      assert(serverlessStub.getProvider.calledWithExactly('aws'));
    });

    it('should set up event hooks', function() {

      const serverlessStub = { getProvider: sinon.stub() };

      const plugin = new PrunePlugin(serverlessStub, {});

      assert(plugin.commands.prune);
      assert(plugin.commands.prune.lifecycleEvents.includes('prune'));
      assert.equal('function', typeof plugin.hooks['prune:prune']);
    });

  });

  describe('deleteVersionsForFunction', function() {

    let serverless;
    let plugin;
    beforeEach(function() {
      serverless = createMockServerless();
      plugin = new PrunePlugin(serverless, {});
    });

    it('should request deletions for each provided version of function', function() {
      const versionMatcher = (ver) => sinon.match({
        FunctionName: 'MyFunction', 
        Qualifier: ver
      });

      plugin.deleteVersionsForFunction('MyFunction', ['1', '2', '3']).then(() => {
        sinon.assert.callCount(plugin.provider.request, 3);
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('1'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('2'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('3'));
      });

    });

    it('should not request deletions if provided versions array is empty', function() {

      plugin.deleteVersionsForFunction('MyFunction', []).then(() => {
        sinon.assert.notCalled(plugin.provider.request);
      });

    });
  });

  describe('prune', function() {

    const functionMatcher = (name) => sinon.match.has('FunctionName', name);
    const versionMatcher = (ver) => sinon.match.has('Qualifier', ver);

    it('should delete old versions of functions', function() {

      const serverless = createMockServerless(['FunctionA', 'FunctionB']);
      const plugin = new PrunePlugin(serverless, { number: 2 });
      
      plugin.provider.request.withArgs('Lambda', 'listVersionsByFunction', sinon.match.any)
        .returns(createVersionsResponse([1, 2, 3, 4, 5]));

      plugin.provider.request.withArgs('Lambda', 'listAliases', sinon.match.any)
        .returns(createAliasResponse([]));

      plugin.prune().then(() => {
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('1'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('2'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('3'));
      });

    });

    it('should keep requested number of version', function() {

      const serverless = createMockServerless(['FunctionA']);
      const plugin = new PrunePlugin(serverless, { number: 3 });
      
      plugin.provider.request.withArgs('Lambda', 'listVersionsByFunction', sinon.match.any)
        .returns(createVersionsResponse([1, 2, 3, 4]));

      plugin.provider.request.withArgs('Lambda', 'listAliases', sinon.match.any)
        .returns(createAliasResponse([]));

      plugin.prune().then(() => {
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('1'));
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('2'));
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('3'));
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('4'));
      });

    });

    it('should not delete $LATEST version', function() {

      const serverless = createMockServerless(['FunctionA']);
      const plugin = new PrunePlugin(serverless, { number: 2 });
      
      plugin.provider.request.withArgs('Lambda', 'listVersionsByFunction', sinon.match.any)
        .returns(createVersionsResponse([1, 2, 3, 4, 5]));

      plugin.provider.request.withArgs('Lambda', 'listAliases', sinon.match.any)
        .returns(createAliasResponse([1, 3]));

      plugin.prune().then(() => {
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('$LATEST'));
      });

    });

    it('should not delete aliased versions', function() {

      const serverless = createMockServerless(['FunctionA']);
      const plugin = new PrunePlugin(serverless, { number: 2 });
      
      plugin.provider.request.withArgs('Lambda', 'listVersionsByFunction', sinon.match.any)
        .returns(createVersionsResponse([1, 2, 3, 4, 5]));

      plugin.provider.request.withArgs('Lambda', 'listAliases', sinon.match.any)
        .returns(createAliasResponse([1, 3, 4]));

      plugin.prune().then(() => {
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('1'));
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('3'));
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('5'));
      });

    });

    it('should always match delete requests to correct function', function() {

      const serverless = createMockServerless(['FunctionA', 'FunctionB']);
      const plugin = new PrunePlugin(serverless, { number: 2 });
      
      plugin.provider.request.withArgs('Lambda', 'listVersionsByFunction', functionMatcher('service-FunctionA'))
        .returns(createVersionsResponse([1]));

      plugin.provider.request.withArgs('Lambda', 'listVersionsByFunction', functionMatcher('service-FunctionB'))
        .returns(createVersionsResponse([1, 2, 3, 4, 5]));

      plugin.provider.request.withArgs('Lambda', 'listAliases', sinon.match.any)
        .returns(createAliasResponse([]));

      plugin.prune().then(() => {
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteFunction', functionMatcher('service-FunctionA'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', functionMatcher('service-FunctionB'));
      });

    });

    it('should ignore functions that are not deployed', function() {

      const serverless = createMockServerless(['FunctionA', 'FunctionB']);
      const plugin = new PrunePlugin(serverless, { number: 1 });
      
      plugin.provider.request.withArgs('Lambda', 'listVersionsByFunction', functionMatcher('service-FunctionA'))
        .returns(BbPromise.reject({ statusCode: 404 }));

      plugin.provider.request.withArgs('Lambda', 'listVersionsByFunction', functionMatcher('service-FunctionB'))
        .returns(createVersionsResponse([1, 2, 3]));

      plugin.provider.request.withArgs('Lambda', 'listAliases', sinon.match.any)
        .returns(createAliasResponse([]));

      plugin.prune().then(() => {
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteFunction', functionMatcher('service-FunctionA'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', functionMatcher('service-FunctionB'));
      });

    });



    it('should only operate on target function if specified from CLI', function() {

      const serverless = createMockServerless(['FunctionA', 'FunctionB', 'FunctionC']);
      const plugin = new PrunePlugin(serverless, { function: 'FunctionA', number: 1 });
      
      plugin.provider.request.withArgs('Lambda', 'listVersionsByFunction', sinon.match.any)
        .returns(createVersionsResponse([1, 2, 3, 4, 5]));

      plugin.provider.request.withArgs('Lambda', 'listAliases', sinon.match.any)
        .returns(createAliasResponse([]));

      plugin.prune().then(() => {
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', functionMatcher('service-FunctionA'));
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteFunction', functionMatcher('service-FunctionB'));
      });

    });

  });

});