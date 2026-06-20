# Changelog

## [0.1.1](https://github.com/pedrofuentes/Council/compare/cli-v0.1.0...cli-v0.1.1) (2026-06-20)


### Bug Fixes

* **extractors:** escape backslashes before pipes in markdown cell escaping ([5df60e1](https://github.com/pedrofuentes/Council/commit/5df60e1dcb75c9e926835c4c248023e2cd297fd2))
* **extractors:** guard html parsing against deep-nesting stack overflow ([c41f756](https://github.com/pedrofuentes/Council/commit/c41f7565beb367e9069a17edd72671f79a35e7ba))
* **extractors:** use node-html-parser for html text extraction (ReDoS-safe, closes [#1212](https://github.com/pedrofuentes/Council/issues/1212)) ([c2a9fa2](https://github.com/pedrofuentes/Council/commit/c2a9fa2fe610285f7ae4a059325426f12cf59104))
