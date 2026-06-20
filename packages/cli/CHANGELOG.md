# Changelog

## [0.2.1](https://github.com/pedrofuentes/Council/compare/cli-v0.2.0...cli-v0.2.1) (2026-06-20)


### Bug Fixes

* **copilot:** resolve the Copilot CLI path so the SDK can spawn it ([82fa2eb](https://github.com/pedrofuentes/Council/commit/82fa2ebe234ecce2d02f5305fa137daec996f880))
* **copilot:** resolve the Copilot CLI path so the SDK can spawn it ([#1273](https://github.com/pedrofuentes/Council/issues/1273)) ([fe00e89](https://github.com/pedrofuentes/Council/commit/fe00e893734cf18958c819a297e88afeae31b13b))

## [0.2.0](https://github.com/pedrofuentes/Council/compare/cli-v0.1.1...cli-v0.2.0) (2026-06-20)


### Features

* **memory:** add node:sqlite Kysely dialect ([cfd6d43](https://github.com/pedrofuentes/Council/commit/cfd6d434ed0c18a8e111e80da46b8823398e376a))
* **memory:** add node:sqlite Kysely dialect ([#1258](https://github.com/pedrofuentes/Council/issues/1258)) ([e276382](https://github.com/pedrofuentes/Council/commit/e2763825f1be8241f91a54b2cafc2598c6d8f56f))


### Bug Fixes

* **build:** preserve node:sqlite prefix in the bundled CLI ([8fce847](https://github.com/pedrofuentes/Council/commit/8fce847fa3ba52b0c7a515d364711e8e47a52ca3))
* **build:** preserve node:sqlite prefix in the bundled CLI ([#1271](https://github.com/pedrofuentes/Council/issues/1271)) ([8b50fe7](https://github.com/pedrofuentes/Council/commit/8b50fe7aff53e29171349eb98d4bf7b7f986c1da))

## [0.1.1](https://github.com/pedrofuentes/Council/compare/cli-v0.1.0...cli-v0.1.1) (2026-06-20)


### Bug Fixes

* **extractors:** escape backslashes before pipes in markdown cell escaping ([5df60e1](https://github.com/pedrofuentes/Council/commit/5df60e1dcb75c9e926835c4c248023e2cd297fd2))
* **extractors:** guard html parsing against deep-nesting stack overflow ([c41f756](https://github.com/pedrofuentes/Council/commit/c41f7565beb367e9069a17edd72671f79a35e7ba))
* **extractors:** use node-html-parser for html text extraction (ReDoS-safe, closes [#1212](https://github.com/pedrofuentes/Council/issues/1212)) ([c2a9fa2](https://github.com/pedrofuentes/Council/commit/c2a9fa2fe610285f7ae4a059325426f12cf59104))
