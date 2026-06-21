# Changelog

## [0.3.0](https://github.com/pedrofuentes/Council/compare/cli-v0.2.1...cli-v0.3.0) (2026-06-21)


### Features

* **doctor:** show live progress spinner while each check runs ([17e8100](https://github.com/pedrofuentes/Council/commit/17e81009b60f990a19e77c400ec067806950f427))
* **doctor:** show live progress spinner while each check runs ([c38226e](https://github.com/pedrofuentes/Council/commit/c38226ede7b90c87e6a242a37971f50d086fab8e))
* **update:** add council update command to self-upgrade the CLI ([97598e9](https://github.com/pedrofuentes/Council/commit/97598e931b4ede1ae4c97fda595b1b033c01338f))
* **update:** add council update command to self-upgrade the CLI ([1801d32](https://github.com/pedrofuentes/Council/commit/1801d32921a71e721e9bded0368a22cfa44df300))
* **version:** add throttled update-available notifier ([2fc62a5](https://github.com/pedrofuentes/Council/commit/2fc62a5fc81fc7a78efbe6a6f7d669d696a82219))
* **version:** throttled update-available notifier + council update notice ([65d6d99](https://github.com/pedrofuentes/Council/commit/65d6d993bc2611ddcf483b3a6b24aa5eb5392d7b))
* **xlsx:** add yauzl/fast-xml-parser xlsx reader ([e84a1cb](https://github.com/pedrofuentes/Council/commit/e84a1cbe993bfb76df8f193a3e4cac0f528f4ff1))


### Bug Fixes

* **experts:** deterministic default expert via monotonic ULID (fixes flaky [#1281](https://github.com/pedrofuentes/Council/issues/1281)) ([0dcc176](https://github.com/pedrofuentes/Council/commit/0dcc176346176fe190c3c93f64433122d5ac9f7c))
* **experts:** use monotonic ULID so default expert is deterministic ([9326220](https://github.com/pedrofuentes/Council/commit/9326220fe4855628c8c7af8a5b65c3e9d008471b))
* **update:** harden child-process execution and registry-error exit code ([36519c2](https://github.com/pedrofuentes/Council/commit/36519c29832031ccd697035b983d97c49035d094))
* **update:** harden council update child-process (timeout, maxBuffer, spawn classification, exit code) ([66edc9d](https://github.com/pedrofuentes/Council/commit/66edc9dd41810527f21df1750da6207a15cc3357))
* **update:** sanitize package-manager output before surfacing in errors ([01b3b8a](https://github.com/pedrofuentes/Council/commit/01b3b8a896eb52f2d6a7a30e60eaf8f0f4c69765))
* **update:** sanitize package-manager output before surfacing in errors ([9f082b1](https://github.com/pedrofuentes/Council/commit/9f082b11eb1c5f6326537021be64d2d530df5046))
* **version:** make update-cache refresh joinable to de-flake corrupt-cache test ([de27820](https://github.com/pedrofuentes/Council/commit/de27820c85bf1b912b0a53c4e9b94921eae807ac))
* **version:** validate/sanitize registry version to prevent terminal escape injection ([ddb5def](https://github.com/pedrofuentes/Council/commit/ddb5defbe39c89087f7a8a457e1c9dbc8508c351))
* **xlsx:** cap column index to OOXML maximum (XFD) to prevent OOM ([709f9ad](https://github.com/pedrofuentes/Council/commit/709f9ade81c4766105e16fd9df29f601e12dcf8b))
* **xlsx:** sanitize sheet names + throw on missing worksheet ([4ebae8f](https://github.com/pedrofuentes/Council/commit/4ebae8f3b2fe79931a3b195c1de75f119a481a13))
* **xlsx:** sanitize sheet names against markdown/prompt injection ([867eb08](https://github.com/pedrofuentes/Council/commit/867eb08e1c04308451c56becf426a802563a8047))
* **xlsx:** throw on a declared-but-missing worksheet part ([f1a6c9d](https://github.com/pedrofuentes/Council/commit/f1a6c9d11beb19487b04490b5a70463e2b6318d7))

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
