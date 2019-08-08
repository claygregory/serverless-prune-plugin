'use strict';

/* eslint-env node, mocha */

const assert = require('assert');
const sinon = require('sinon');

const PrunePlugin = require('../');

describe('Prune', function() {

  function createMockServerlessWithLayers(layers, serviceCustom) {
    let serverless = createMockServerless([], serviceCustom);
    const { service } = serverless;

    const withLayers = Object.assign(
      serverless.service, 
      service, 
      { 
        getAllLayers: () => layers,
        getLayer: (key) => { return { name: `layer-${key}` }; },
      }
    );

    return Object.assign(serverless, withLayers);
  }

  function createMockServerless(functions, serviceCustom) {
    const serverless = {
      getProvider: sinon.stub(),
      cli: { log: sinon.stub() },
      service: {
        getAllFunctions: () => functions,
        getFunction: (key) => { return { name:`service-${key}` }; },
        custom: serviceCustom
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

  function createLayerVersionsResponse(versions) {
    const resp = {};

    resp.LayerVersions = versions.map(v => {
      return {
        Version: '' + v
      };
    });

    return Promise.resolve(resp);
  }

  describe('constructor', function() {

    it('should assign correct properties', function() {

      const serverlessStub = createMockServerless([], null);
      
      const provider = { aws: 'provider' };
      const options = { option: 'a' };
      serverlessStub.getProvider.withArgs('aws').returns(provider);

      const plugin = new PrunePlugin(serverlessStub, options);

      assert.strictEqual(serverlessStub, plugin.serverless);
      assert.strictEqual(options, plugin.options);

      assert(serverlessStub.getProvider.calledOnce);
      assert(serverlessStub.getProvider.calledWithExactly('aws'));
    });

    it('should assign any serverless.yml configured options', function() {

      const serverlessStub = createMockServerless([], {
        prune: {
          automatic: true,
          number: 5
        }
      });

      const plugin = new PrunePlugin(serverlessStub, {});

      assert(plugin.pluginCustom);
      assert.equal(5, plugin.pluginCustom.number);
      assert.equal(true, plugin.pluginCustom.automatic);

      assert.equal(5, plugin.getNumber());
    });

    it('should set up event hooks', function() {

      const serverlessStub = createMockServerless([], null);

      const plugin = new PrunePlugin(serverlessStub, {});

      assert(plugin.commands.prune);
      assert(plugin.commands.prune.lifecycleEvents.indexOf('prune') >= 0);
      assert.equal('function', typeof plugin.hooks['prune:prune']);
      assert.equal('function', typeof plugin.hooks['after:deploy:deploy']);
    });

    it('should prioritize CLI provided n over serverless.yml value', function() {

      const serverlessStub = createMockServerless([], {
        prune: { automatic: true, number: 5 }
      });

      const plugin = new PrunePlugin(serverlessStub, { number: 7 });

      assert(plugin.pluginCustom);
      assert.equal(5, plugin.pluginCustom.number);
      assert.equal(7, plugin.getNumber());
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

      return plugin.deleteVersionsForFunction('MyFunction', ['1', '2', '3']).then(() => {
        sinon.assert.callCount(plugin.provider.request, 3);
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('1'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('2'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('3'));
      });

    });

    it('should not request deletions if provided versions array is empty', function() {

      return plugin.deleteVersionsForFunction('MyFunction', []).then(() => {
        sinon.assert.notCalled(plugin.provider.request);
      });

    });
  });

  describe('deleteVersionsForFunction - lambda edge', function() {

    let serverless;
    let plugin;
    beforeEach(function() {
      serverless = createMockServerless();
      plugin = new PrunePlugin(serverless, {});
    });

    it('should ignore failure while deleting lambda edge function', function(done) {

      plugin.provider.request.withArgs('Lambda', 'deleteFunction', sinon.match.any)
        .rejects({ statusCode: 400, message: 'Lambda was unable to delete arn:aws:lambda:REGION:ACCOUNT_ID:function:FUNCTION_NAME:FUNCTION_VERSION because it is a replicated function. Please see our documentation for Deleting Lambda@Edge Functions and Replicas.' });

      plugin.deleteVersionsForFunction('MyEdgeFunction', [1])
        .then(() => done())
        .catch(() => done(new Error('shouldn\'t fail')));

    });

    it('should fail when error while deleting regular lambda function', function(done) {

      plugin.provider.request.withArgs('Lambda', 'deleteFunction', sinon.match.any)
        .rejects({ statusCode: 400, message: 'Some Error' });

      plugin.deleteVersionsForFunction('MyFunction', [1])
        .then(() => done(new Error('should fail')))
        .catch(() => done());

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

      return plugin.prune().then(() => {
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('1'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('2'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', versionMatcher('3'));
      });

    });

    it('should keep requested number of version', function() {

      const serverless = createMockServerless(['FunctionA'], {
        prune: { automatic: true, number: 5 }
      });
      const plugin = new PrunePlugin(serverless, { number: 3 });
      
      plugin.provider.request.withArgs('Lambda', 'listVersionsByFunction', sinon.match.any)
        .returns(createVersionsResponse([1, 2, 3, 4]));

      plugin.provider.request.withArgs('Lambda', 'listAliases', sinon.match.any)
        .returns(createAliasResponse([]));

      return plugin.prune().then(() => {
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

      return plugin.prune().then(() => {
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

      return plugin.prune().then(() => {
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

      return plugin.prune().then(() => {
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteFunction', functionMatcher('service-FunctionA'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', functionMatcher('service-FunctionB'));
      });

    });

    it('should ignore functions that are not deployed', function() {

      const serverless = createMockServerless(['FunctionA', 'FunctionB']);
      const plugin = new PrunePlugin(serverless, { number: 1 });
      
      plugin.provider.request.withArgs('Lambda', 'listVersionsByFunction', functionMatcher('service-FunctionA'))
        .rejects({ statusCode: 404 });

      plugin.provider.request.withArgs('Lambda', 'listAliases', functionMatcher('service-FunctionA'))
        .rejects({ statusCode: 404 });

      plugin.provider.request.withArgs('Lambda', 'listVersionsByFunction', functionMatcher('service-FunctionB'))
        .returns(createVersionsResponse([1, 2, 3]));

      plugin.provider.request.withArgs('Lambda', 'listAliases', sinon.match.any)
        .returns(createAliasResponse([]));

      return plugin.prune().then(() => {
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

      return plugin.prune().then(() => {
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteFunction', functionMatcher('service-FunctionA'));
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteFunction', functionMatcher('service-FunctionB'));
      });

    });

    it('should not perform any deletions if dryRun flag is set', function() {

      const serverless = createMockServerless(['FunctionA', 'FunctionB', 'FunctionC']);
      const plugin = new PrunePlugin(serverless, {  number: 1, dryRun: true });
      sinon.spy(plugin, 'deleteVersionsForFunction');
      
      plugin.provider.request.withArgs('Lambda', 'listVersionsByFunction', sinon.match.any)
        .returns(createVersionsResponse([1, 2, 3, 4, 5]));

      plugin.provider.request.withArgs('Lambda', 'listAliases', sinon.match.any)
        .returns(createAliasResponse([]));

      return plugin.prune().then(() => {
        sinon.assert.notCalled(plugin.deleteVersionsForFunction);
      });

    });

  });

  describe('pruneLayers', function() {
    const layerMatcher = (name) => sinon.match.has('LayerName', name);
    const versionMatcher = (ver) => sinon.match.has('VersionNumber', ver);

    it('should delete old versions of layers', function () {

      const serverless = createMockServerlessWithLayers(['LayerA', 'LayerB'], { prune: { includeLayers: true }});
      const plugin = new PrunePlugin(serverless, { number: 2, includeLayers: true });

      plugin.provider.request.withArgs('Lambda', 'listLayerVersions', sinon.match.any)
        .returns(createLayerVersionsResponse([1, 2, 3, 4, 5]));

      return plugin.pruneLayers().then(() => {
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', versionMatcher('1'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', versionMatcher('2'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', versionMatcher('3'));
      });

    });

    it('should keep requested number of version', function () {

      const serverless = createMockServerlessWithLayers(['LayerA'], {
        prune: { automatic: true, number: 5, includeLayers: true },
      });
      const plugin = new PrunePlugin(serverless, { number: 3 });

      plugin.provider.request.withArgs('Lambda', 'listLayerVersions', sinon.match.any)
        .returns(createLayerVersionsResponse([1, 2, 3, 4]));

      return plugin.pruneLayers().then(() => {
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', versionMatcher('1'));
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', versionMatcher('2'));
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', versionMatcher('3'));
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', versionMatcher('4'));
      });

    });

    it('should always match delete requests to correct layer', function () {

      const serverless = createMockServerlessWithLayers(['LayerA', 'LayerB']);
      const plugin = new PrunePlugin(serverless, { number: 1, includeLayers: true });

      plugin.provider.request.withArgs('Lambda', 'listLayerVersions', layerMatcher('layer-LayerA'))
        .returns(createLayerVersionsResponse([1]));

      plugin.provider.request.withArgs('Lambda', 'listLayerVersions', layerMatcher('layer-LayerB'))
        .returns(createLayerVersionsResponse([1, 2, 3]));

      return plugin.pruneLayers().then(() => {
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', layerMatcher('layer-LayerA'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', layerMatcher('layer-LayerB'));
      });

    });

    it('should ignore layers that are not deployed', function () {

      const serverless = createMockServerlessWithLayers(['LayerA', 'LayerB']);
      const plugin = new PrunePlugin(serverless, { number: 1, includeLayers: true });

      plugin.provider.request.withArgs('Lambda', 'listLayerVersions', layerMatcher('layer-LayerA'))
        .rejects({ statusCode: 404 });

      plugin.provider.request.withArgs('Lambda', 'listLayerVersions', layerMatcher('layer-LayerB'))
        .returns(createLayerVersionsResponse([1, 2, 3]));

      return plugin.pruneLayers().then(() => {
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', layerMatcher('layer-LayerA'));
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', layerMatcher('layer-LayerB'));
      });

    });

    it('should only operate on target layer if specified from CLI', function () {

      const serverless = createMockServerlessWithLayers(['LayerA', 'LayerB', 'LayerC']);
      const plugin = new PrunePlugin(serverless, { layer: 'LayerA', includeLayers: true, number: 1 });

      plugin.provider.request.withArgs('Lambda', 'listLayerVersions', sinon.match.any)
        .returns(createLayerVersionsResponse([1, 2, 3, 4, 5]));

      return plugin.pruneLayers().then(() => {
        sinon.assert.calledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', layerMatcher('layer-LayerA'));
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', layerMatcher('layer-LayerB'));
        sinon.assert.neverCalledWith(plugin.provider.request, 'Lambda', 'deleteLayerVersion', layerMatcher('layer-LayerC'));
      });

    });

    it('should not perform any layer deletions if dryRun flag is set', function () {

      const serverless = createMockServerlessWithLayers(['LayerA', 'LayerB', 'LayerC']);
      const plugin = new PrunePlugin(serverless, { number: 1, dryRun: true, includeLayers: true });
      sinon.spy(plugin, 'deleteVersionsForLayer');

      plugin.provider.request.withArgs('Lambda', 'listLayerVersions', sinon.match.any)
        .returns(createLayerVersionsResponse([1, 2, 3, 4, 5]));

      return plugin.pruneLayers().then(() => {
        sinon.assert.notCalled(plugin.deleteVersionsForLayer);
      });

    });
  });

  describe('postDeploy', function() {

    it('should prune functions if automatic is option is configured', function() {

      const custom = {
        prune: { automatic: true, number: 10 }
      };
      const serverlessStub = createMockServerless([], custom);

      const plugin = new PrunePlugin(serverlessStub, {});
      sinon.spy(plugin, 'prune');

      return plugin.postDeploy().then(() => {
        sinon.assert.calledOnce(plugin.prune);
      });
    });

    it('should not prune functions if noDeploy flag is set', function() {

      const serverlessStub = createMockServerless([], null);

      const options = { noDeploy: true };
      const plugin = new PrunePlugin(serverlessStub, options);
      sinon.spy(plugin, 'prune');

      return plugin.postDeploy().then(() => {
        sinon.assert.notCalled(plugin.prune);
      });
    });

    it('should not prune layers if no option is set', function() {
      const serverlessStub = createMockServerlessWithLayers([], null);

      const options = { automatic: true };
      const plugin = new PrunePlugin(serverlessStub, options);
      sinon.spy(plugin, 'pruneLayers');

      return plugin.postDeploy().then(() => {
        sinon.assert.notCalled(plugin.pruneLayers);
      });
    });

  });

  describe('Logging', function() {

    it('should log input when SLS_DEBUG = "*"', function() {
      process.env.SLS_DEBUG = '*';

      const serverlessStub = createMockServerless([], { 
        prune: {
          automatic: true,
          number: 1
        }
      });

      const plugin = new PrunePlugin(serverlessStub, {});
      sinon.spy(plugin, 'log');

      return plugin.postDeploy().then(() => {
        sinon.assert.called(plugin.log);
      });
    });

    it('should not log input when SLS_DEBUG is undefined', function () {
      process.env.SLS_DEBUG = undefined;

      const serverlessStub = createMockServerless([], {
        prune: {
          automatic: true,
          number: 1
        }
      });

      const plugin = new PrunePlugin(serverlessStub, {});
      sinon.spy(plugin, 'log');

      return plugin.postDeploy().then(() => {
        sinon.assert.notCalled(plugin.serverless.cli.log);
      });
    });
  });

});