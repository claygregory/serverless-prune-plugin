
# Serverless Prune Plugin

Following deployment, the Serverless Framework does not purge previous versions of functions from AWS, so the number of deployed versions can grow out of hand rather quickly. This plugin allows pruning of all but the most recent version(s) of managed functions from AWS. This plugin targets Serverless 1.x.

[![Serverless](http://public.serverless.com/badges/v3.svg)](http://www.serverless.com)
[![Build Status](https://travis-ci.org/claygregory/serverless-prune-plugin.svg?branch=master)](https://travis-ci.org/claygregory/serverless-prune-plugin)
[![Coverage Status](https://coveralls.io/repos/github/claygregory/serverless-prune-plugin/badge.svg?branch=master)](https://coveralls.io/github/claygregory/serverless-prune-plugin?branch=master)

## Installation

Install to project via npm:
```
npm install --save-dev serverless-prune-plugin
```

Add the plugin to your `serverless.yml` file:
```yaml
plugins:
  - serverless-prune-plugin
```

## Usage

In the project root, run:
```
sls prune -n <number of version to keep>
```

This will delete all but the `n`-most recent versions of each function deployed. Versions referenced by an alias are automatically preserved.

### Single Function

A single function can be targeted for cleanup:
```
sls prune -n <number of version to keep> -f <function name>
```

### Additional Help

See:
```
sls prune --help
```

## See Also

The [Serverless Autoprune Plugin](https://github.com/arabold/serverless-autoprune-plugin) by [arabold](https://github.com/arabold) performs a similar role, but only targets Serverless 0.5.x projects.

## License

See the included [LICENSE](LICENSE.md) for rights and limitations under the terms of the MIT license.
