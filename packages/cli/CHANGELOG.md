# Changelog

## [0.6.0](https://github.com/pedrofuentes/Council/compare/cli-v0.5.0...cli-v0.6.0) (2026-07-02)


### Features

* **convene:** TTY-gated progress during conclusion synthesis ([#1848](https://github.com/pedrofuentes/Council/issues/1848)). Sentinel: sentinel-pr1869-eb22567-20260630T082300Z reviewed-sha eb225675cab4a629d092cccbaefc85764819b8f2 (APPROVED). ([cb49610](https://github.com/pedrofuentes/Council/commit/cb496103c285d4c43e621101b9037a348d6a0077))
* **tui:** advertise Actions (a) binding on detail screen shortcuts ([5c1968f](https://github.com/pedrofuentes/Council/commit/5c1968fdd1a9335ec7c813356b79d3bd14a8858d)), closes [#1752](https://github.com/pedrofuentes/Council/issues/1752)
* **tui:** auto-conclude debate stream on successful completion ([#1851](https://github.com/pedrofuentes/Council/issues/1851)). Sentinel: sentinel-1868-8e3d515-20260630T0830 reviewed-sha 8e3d5158b479d351be1d5f8c1a4d3d9f93c8d266 (APPROVED). ([38de0fc](https://github.com/pedrofuentes/Council/commit/38de0fc58c64a0fbf081ed3d39863b17688eef6d))
* **tui:** persist stored panel definition for convene sessions ([914de7d](https://github.com/pedrofuentes/Council/commit/914de7d295de9cef537e1308a1421a225c77a193)), closes [#1681](https://github.com/pedrofuentes/Council/issues/1681)
* **tui:** persist stored panel definition for convene sessions ([#1681](https://github.com/pedrofuentes/Council/issues/1681)). Sentinel: SENT-1870-20260630-tui-persist reviewed-sha 914de7d295de9cef537e1308a1421a225c77a193 (APPROVED). ([3fa1278](https://github.com/pedrofuentes/Council/commit/3fa1278b5a5602a3bbef8736251ba32e841caa5d))


### Bug Fixes

* **ai-fallback:** memoize allowlist, guard hashing, streamline word count, harden filename sink ([c60cfc4](https://github.com/pedrofuentes/Council/commit/c60cfc4a4366d61d33086b570b6be6afb3b41624))
* **ask:** sanitize LLM-sourced expert displayName/slug in terminal output ([853a7dc](https://github.com/pedrofuentes/Council/commit/853a7dc6dbcc4cbc1e04bcaafadb54fd02b0c0c5)), closes [#1811](https://github.com/pedrofuentes/Council/issues/1811)
* **auto-compose:** log recoverable retries and thread retry context into exhaustion error ([ed6f927](https://github.com/pedrofuentes/Council/commit/ed6f9275ca2a232aedc7684ad147393102738a86))
* **bin:** harden CLI entrypoint arg gating and Windows chcp resolution ([9bfb106](https://github.com/pedrofuentes/Council/commit/9bfb106d77c44bf94bae81409b1bbc784b2376a6))
* **chat:** cap per-turn RAG excerpts at both chat sinks ([#1091](https://github.com/pedrofuentes/Council/issues/1091)) ([c68fc00](https://github.com/pedrofuentes/Council/commit/c68fc0000349c3267b5fc15bef92bf0f13ad6bbb))
* **chat:** confine generic-member docs warning to the experts root ([e3b3183](https://github.com/pedrofuentes/Council/commit/e3b318309a23526a61fa3b4b8dc52f3810cfa72d))
* **chat:** warn on generic panel member unindexed docs ([#1103](https://github.com/pedrofuentes/Council/issues/1103)) ([4c05ac0](https://github.com/pedrofuentes/Council/commit/4c05ac077e682defaa4cf26e09b466dd4df2559a))
* **cli:** describe --history as active and archived in help ([#1110](https://github.com/pedrofuentes/Council/issues/1110)) ([9e510d9](https://github.com/pedrofuentes/Council/commit/9e510d9206a4d04f2d73ade5801c3ea18497fbc6))
* **cli:** document panel create --experts ordering and hint on absorbed name ([#1059](https://github.com/pedrofuentes/Council/issues/1059)) ([7836960](https://github.com/pedrofuentes/Council/commit/7836960bdf14e81f70d5273fbd342612218e8e79))
* **cli:** note cost-indicator suppression in --quiet description ([#850](https://github.com/pedrofuentes/Council/issues/850)) ([8424d08](https://github.com/pedrofuentes/Council/commit/8424d0821f3d6d822f83725b718e50bf68bfa30a))
* **cli:** sanitize model in error hints and recover untagged engine errors ([9ae134c](https://github.com/pedrofuentes/Council/commit/9ae134c9ebdf23454fcc5f6faf95337447b83b60))
* **cli:** sanitize untrusted session-resolver stderr output ([c52c706](https://github.com/pedrofuentes/Council/commit/c52c70698651d2a1d02edfc0a1f501f3c12a28cf)), closes [#779](https://github.com/pedrofuentes/Council/issues/779)
* **conclude:** re-sample synthesizer retry from a fresh session ([#1133](https://github.com/pedrofuentes/Council/issues/1133)) ([37be9e4](https://github.com/pedrofuentes/Council/commit/37be9e477332f67c5f9c07a3eb1847c0d52601dd))
* **config:** clean up orphan lock on write failure; verify token on release ([cc54e31](https://github.com/pedrofuentes/Council/commit/cc54e3196e0800a1e505217e8a5fbb2efaefa2d3))
* **config:** do not reap a live same-host owner config lock ([#742](https://github.com/pedrofuentes/Council/issues/742)) ([06df1fb](https://github.com/pedrofuentes/Council/commit/06df1fb34a2ae7675f1893c0c754d5faf9e1512a))
* **config:** exclusive-create default write, stale-lock reaping, env normalization ([5de0435](https://github.com/pedrofuentes/Council/commit/5de04358fe04f2b700e3cd6a90fdf1219644be7c))
* **config:** harden config-command echo, write-lock, and picker boundary ([44315e4](https://github.com/pedrofuentes/Council/commit/44315e4dfc3ff0f0ad43cd2a564c8746a9df2b90))
* **config:** release own lock on transient read failure ([#2102](https://github.com/pedrofuentes/Council/issues/2102)) ([0432657](https://github.com/pedrofuentes/Council/commit/043265706a1ec8c2b60b20fda2290392b13bf54c))
* **context-manager:** configurable summarizer timeout & abort observability ([b0ac120](https://github.com/pedrofuentes/Council/commit/b0ac1208c296afd8981db099dedfbbdcb8212363))
* **context:** label thrown timeout distinctly and guard best-effort warning sink ([5b644e3](https://github.com/pedrofuentes/Council/commit/5b644e35405f5eb0d60adc514e157c06bca52755))
* **convene:** document --experts ordering foot-gun and hint on empty topic ([#1059](https://github.com/pedrofuentes/Council/issues/1059)) ([1fe8c4e](https://github.com/pedrofuentes/Council/commit/1fe8c4eb7fad17adfbe88807baab75c481a78494))
* **convene:** state auto-conclude cost as 1-2 premium requests ([#1469](https://github.com/pedrofuentes/Council/issues/1469)) ([152755f](https://github.com/pedrofuentes/Council/commit/152755fc0872770df419ac15badc4b3937a53aaf))
* **convene:** surface variadic ordering hint for absorbed-topic --experts slugs ([f92cbfb](https://github.com/pedrofuentes/Council/commit/f92cbfb3f564fa4e170c4c3713d9fca322267242))
* **convene:** validate --human slugs, fail fast on empty/collision ([#207](https://github.com/pedrofuentes/Council/issues/207)) ([65595cb](https://github.com/pedrofuentes/Council/commit/65595cb71bb8da55f1789deb14a154d79c8b6996))
* **copilot-adapter:** classify token-limit overflow as CONTEXT_OVERFLOW; doc SDK subprocess caveat ([3c7f41f](https://github.com/pedrofuentes/Council/commit/3c7f41f954594d7fc587dc99c2bf2aa5cb13e51b)), closes [#57](https://github.com/pedrofuentes/Council/issues/57) [#59](https://github.com/pedrofuentes/Council/issues/59) [#720](https://github.com/pedrofuentes/Council/issues/720) [#1899](https://github.com/pedrofuentes/Council/issues/1899) [#1900](https://github.com/pedrofuentes/Council/issues/1900)
* **copilot:** reap model-discovery subprocess via forceStop on timeout ([46856c5](https://github.com/pedrofuentes/Council/commit/46856c5007cad60059fd73011eea43fce8f08981)), closes [#1899](https://github.com/pedrofuentes/Council/issues/1899)
* **core:** bound summarizer send, surface failures, cap transcript ([28c295a](https://github.com/pedrofuentes/Council/commit/28c295abd195d826c1001c9e854eb6e9456fb8d3)), closes [#267](https://github.com/pedrofuentes/Council/issues/267) [#268](https://github.com/pedrofuentes/Council/issues/268) [#271](https://github.com/pedrofuentes/Council/issues/271)
* **core:** harden auto-compose retry, cleanup, abort, and mock detection ([df2ba47](https://github.com/pedrofuentes/Council/commit/df2ba470e2cb82df96fc86d7b814e36d44af8714))
* **core:** sanitize migration errors and isolate per-panel failures ([d91724a](https://github.com/pedrofuentes/Council/commit/d91724a4a8c520791418f70d7c78bdc1d1b0e1c8))
* **council:** extract update-notice quiet resolution ([#1286](https://github.com/pedrofuentes/Council/issues/1286)) ([15e4502](https://github.com/pedrofuentes/Council/commit/15e4502616439b187a232065d194e23e92816bd0))
* **csv:** gate blank-line skip on multi-column header ([edcc1e0](https://github.com/pedrofuentes/Council/commit/edcc1e0b3e908416fc4c40b409dafd98473aec9b))
* **csv:** report true source line in corrupt-document diagnostic ([#2004](https://github.com/pedrofuentes/Council/issues/2004)) ([2154a36](https://github.com/pedrofuentes/Council/commit/2154a363fda72096ed691da0995dd9bd324c371d))
* **csv:** skip blank lines before column-count validation ([bbf446a](https://github.com/pedrofuentes/Council/commit/bbf446aaf2c1f7176ce8be3789e6acc1bad31faa)), closes [#1801](https://github.com/pedrofuentes/Council/issues/1801) [#946](https://github.com/pedrofuentes/Council/issues/946)
* **debate:** surface failed structured-debate turns as placeholders ([#108](https://github.com/pedrofuentes/Council/issues/108)) ([69354e8](https://github.com/pedrofuentes/Council/commit/69354e8d98af6de41e60b0d194caa63ec3b6070c))
* **docs:** extract containment assertion for direct branch testability ([0f9c097](https://github.com/pedrofuentes/Council/commit/0f9c09768a60dbe8a5b0bed8cddd3da7b2e16477))
* **doctor:** probe experts/ and panels/ write targets in data-home check ([a892c49](https://github.com/pedrofuentes/Council/commit/a892c49e5c236ee92ce31a01bf976705b5f929c5)), closes [#1914](https://github.com/pedrofuentes/Council/issues/1914)
* **doctor:** sanitize Terminal env display and verify data-home writability ([58c2c45](https://github.com/pedrofuentes/Council/commit/58c2c45a5aee148fe50844db2fec1875b5778780))
* **documents:** add DOCX per-entry uncompressed cap and honor AbortSignal ([640ae32](https://github.com/pedrofuentes/Council/commit/640ae322f7a5a1ed4ef1951a020e470a6474218d)), closes [#949](https://github.com/pedrofuentes/Council/issues/949) [#950](https://github.com/pedrofuentes/Council/issues/950)
* **e2e:** pair turn-events by expert identity instead of array index ([#637](https://github.com/pedrofuentes/Council/issues/637)) ([4d1b1ff](https://github.com/pedrofuentes/Council/commit/4d1b1ff57ee6de1d94534f0e32082627db24e804))
* **e2e:** tune waitForDbRelease poll interval per platform ([#646](https://github.com/pedrofuentes/Council/issues/646)) ([e3ced5b](https://github.com/pedrofuentes/Council/commit/e3ced5b8251f02230a760a739a752efced980fd5))
* **engine:** harden Copilot adapter cleanup, discovery, and diagnostics ([f176637](https://github.com/pedrofuentes/Council/commit/f17663766613fc9b00bc2ff72f31b367ced1a58d))
* **engine:** route recoverable 'token limit' quota to RATE_LIMITED ([#1968](https://github.com/pedrofuentes/Council/issues/1968)) ([4e093b8](https://github.com/pedrofuentes/Council/commit/4e093b860b1fc305b064341263f5ebd2ce88d368))
* **error-mapper:** sanitize recovered provider + guard cause-chain reads ([afb6ce9](https://github.com/pedrofuentes/Council/commit/afb6ce9ea586a7197f89ae867f90e1fec724c08d))
* **expert-library:** surface DB-row/missing-YAML integrity mismatch ([#288](https://github.com/pedrofuentes/Council/issues/288)) ([c014ed2](https://github.com/pedrofuentes/Council/commit/c014ed23f3d3f4a754af4413fa941b012e48b56f))
* **expert:** confine docsPath by rejecting .. traversal only (preserve documented absolute custom-location) ([fa41a6a](https://github.com/pedrofuentes/Council/commit/fa41a6add9c71a00359d43bdb4e6507236123e72))
* **expert:** confine docsPath to expert docs root (reject traversal + out-of-root absolute) ([1252756](https://github.com/pedrofuentes/Council/commit/1252756cda99fa40d5f97fca490645c9e570b741)), closes [#287](https://github.com/pedrofuentes/Council/issues/287)
* **expert:** confine docsPath to relative in-root paths ([#287](https://github.com/pedrofuentes/Council/issues/287)) ([5dfd3f8](https://github.com/pedrofuentes/Council/commit/5dfd3f853dd60fa151d97713181825b716a165ac))
* **expert:** make docs commit phase atomic with rollback ([#1084](https://github.com/pedrofuentes/Council/issues/1084)) ([5c07ee8](https://github.com/pedrofuentes/Council/commit/5c07ee896529a8783d71f69b80f1c99c36206731))
* **expert:** reject bidi/zero-width chars in derived filenames ([eda2d93](https://github.com/pedrofuentes/Council/commit/eda2d932a674d101a5f4e134fba458ba99b0f8e5)), closes [#1957](https://github.com/pedrofuentes/Council/issues/1957)
* **expert:** reject C1/LS/PS filenames + atomic fail-closed commitStagedDocs ([314219a](https://github.com/pedrofuentes/Council/commit/314219acdfe7837963f7935db0939551119ffcbd))
* **expert:** sanitize URL sinks and harden commit rollback ([2b1a67a](https://github.com/pedrofuentes/Council/commit/2b1a67afbbac58813cfa2adebf0d1f5f999566c8))
* **export:** clean up temp file on any pre-rename failure ([#1964](https://github.com/pedrofuentes/Council/issues/1964)) ([1f63e0a](https://github.com/pedrofuentes/Council/commit/1f63e0a2a1695c7345bda870eea4cc5e252f7b38))
* **export:** contain output path, ENOENT-only catch, per-line ADR prefixing, sanitize Next hint ([#173](https://github.com/pedrofuentes/Council/issues/173) [#1475](https://github.com/pedrofuentes/Council/issues/1475) [#1476](https://github.com/pedrofuentes/Council/issues/1476) [#1792](https://github.com/pedrofuentes/Council/issues/1792)) ([3d81681](https://github.com/pedrofuentes/Council/commit/3d81681ac4168561a69249e8b8c5bc2cbbb87f46))
* **export:** neutralize block markers in per-expert blockquotes ([#2110](https://github.com/pedrofuentes/Council/issues/2110)) ([985800a](https://github.com/pedrofuentes/Council/commit/985800ad19ba253935b6d474a0a1342dbc4e4d66))
* **export:** neutralize blockquote markdown-injection in share exporter ([#2123](https://github.com/pedrofuentes/Council/issues/2123)) ([b0de571](https://github.com/pedrofuentes/Council/commit/b0de571561871064a8365aca56b63907368bc259))
* **export:** realpath-deref containment, atomic rename-into-place, blockquote continuation, sanitized CliUserError ([2e588f3](https://github.com/pedrofuentes/Council/commit/2e588f3e8ab7244d3c54aa84896dd6a2254a7454))
* **export:** strip leading indent on ADR continuation lines ([d7054b0](https://github.com/pedrofuentes/Council/commit/d7054b0cc8bd504c1d889d90621c78d6b9176e2f)), closes [#1884](https://github.com/pedrofuentes/Council/issues/1884)
* **export:** wrap writeExportArtifact fs errors in CliUserError ([#1887](https://github.com/pedrofuentes/Council/issues/1887)) ([d194db8](https://github.com/pedrofuentes/Council/commit/d194db89a0162b601b0e5a41ee7cadf03e70104c))
* **html:** narrow deep-nesting catch to RangeError and honor ctx.signal ([f8cd07a](https://github.com/pedrofuentes/Council/commit/f8cd07a6ee6f3d801297ec1a39ed322f55fadf4b))
* **ink:** cancel stream on unmount, memoize history rows, bind separator width ([2fd958b](https://github.com/pedrofuentes/Council/commit/2fd958bc9de5b0162b34e547b450d7c43b33f27e))
* **memory:** add aggregate COUNT methods to repos ([8c3a4f4](https://github.com/pedrofuentes/Council/commit/8c3a4f4433f7e86c0e42ded488f21d8c89235676))
* **memory:** bound extractor engine.send with a timeout/abort budget ([#275](https://github.com/pedrofuentes/Council/issues/275)) ([51bc74b](https://github.com/pedrofuentes/Council/commit/51bc74b27db183664990e9e1ffd227ef13435814))
* **memory:** replace N+1 turn-count loop with single COUNT query ([#180](https://github.com/pedrofuentes/Council/issues/180)) ([f80c471](https://github.com/pedrofuentes/Council/commit/f80c4718e811d4a35ee5b7972b13f905782db990))
* **memory:** surface silent extraction timeout via console.warn ([8d77606](https://github.com/pedrofuentes/Council/commit/8d77606c99c63e92442de9fc4d656aa07daed437))
* **models:** freeze SUPPORTED_MODELS at definition ([#1095](https://github.com/pedrofuentes/Council/issues/1095)) ([8e79d12](https://github.com/pedrofuentes/Council/commit/8e79d12feafce76174c74a1332b3f653d5c41c68))
* **moderator:** honor configured maxSummaryLength when rendering rolling summary ([#635](https://github.com/pedrofuentes/Council/issues/635)) ([d627b14](https://github.com/pedrofuentes/Council/commit/d627b14310f7ce4cf964c0a535542acfc3de5b00))
* **panel:** harden docs containment, edit ordering, and delete/list recovery ([1fe58d9](https://github.com/pedrofuentes/Council/commit/1fe58d9b7e100195b0839ffd7af2149de685c918))
* **panel:** harden panel command sinks ([#312](https://github.com/pedrofuentes/Council/issues/312) [#758](https://github.com/pedrofuentes/Council/issues/758) [#1055](https://github.com/pedrofuentes/Council/issues/1055) [#1063](https://github.com/pedrofuentes/Council/issues/1063) [#1114](https://github.com/pedrofuentes/Council/issues/1114) [#1115](https://github.com/pedrofuentes/Council/issues/1115) [#1825](https://github.com/pedrofuentes/Council/issues/1825) [#1929](https://github.com/pedrofuentes/Council/issues/1929)) ([24227dc](https://github.com/pedrofuentes/Council/commit/24227dcec784aae07c759d08e1171912349a58e1))
* **panel:** recover from DB-delete failure across CLI and TUI delete paths ([d316641](https://github.com/pedrofuentes/Council/commit/d3166414cf04dca6890c1e6e1518de1cc86088f7))
* **panel:** sanitize malformed config_json diagnostic before stderr echo ([05efb4f](https://github.com/pedrofuentes/Council/commit/05efb4f671b93618930eb4b584cf88dc2f61c2af))
* **persister:** enrich orphan turn.end warning with debateId ([#163](https://github.com/pedrofuentes/Council/issues/163)) ([dd2719b](https://github.com/pedrofuentes/Council/commit/dd2719b1713cb4f0ac8ed1e5dd391f791507266c))
* **plain:** collapse horizontal tab in header sanitization (use toSingleLineDisplay) ([bace11b](https://github.com/pedrofuentes/Council/commit/bace11b06e1e3504cd18af6df86a8f90b129d1f3))
* **plain:** sanitize LLM displayName in headers and handle EPIPE ([b217c24](https://github.com/pedrofuentes/Council/commit/b217c24d62f72ced3750797d4f0f87c96616587c))
* **pptx:** make readEntryBuffer honor the abort signal mid-read ([#1810](https://github.com/pedrofuentes/Council/issues/1810)) ([e0c2ea5](https://github.com/pedrofuentes/Council/commit/e0c2ea5ce95a3c557f98abe7bf8e102c1bf6bee5))
* **processor:** error-isolate + gate ask-mode eviction; document unsupported lifecycle ([c544746](https://github.com/pedrofuentes/Council/commit/c544746d911a6fa8fb726d15e548e4b18e8afa00))
* **prompt-builder:** make expert no-tool-access constraint explicit (T-11) ([045c67c](https://github.com/pedrofuentes/Council/commit/045c67cdfbd6d20c68e2cc89e63860a2113002df))
* **registry:** evict rejected loader promises from the extractor cache ([a20113e](https://github.com/pedrofuentes/Council/commit/a20113e0e754246dd95634f727dfa4742e24f2a8)), closes [#924](https://github.com/pedrofuentes/Council/issues/924) [#925](https://github.com/pedrofuentes/Council/issues/925)
* **renderers:** collapse TAB in PlainRenderer single-line sanitize ([#675](https://github.com/pedrofuentes/Council/issues/675)) ([3dfdec1](https://github.com/pedrofuentes/Council/commit/3dfdec1811b985651e52066f83fcc3c1176069ce))
* **renderers:** handle EPIPE gracefully in JsonRenderer ([88adec6](https://github.com/pedrofuentes/Council/commit/88adec6505379d3a3f686ec5cdfbb2b21ee09247))
* **resume:** keep SIGINT handler live until interrupted flush completes ([9b825bc](https://github.com/pedrofuentes/Council/commit/9b825bcd49e10349ec2d3030f77b660cff6d7c19)), closes [#811](https://github.com/pedrofuentes/Council/issues/811) [#812](https://github.com/pedrofuentes/Council/issues/812)
* **retry:** thread stable reasonCode through turn.retry ([#674](https://github.com/pedrofuentes/Council/issues/674)) ([e6b2d07](https://github.com/pedrofuentes/Council/commit/e6b2d07b81d3738e40791ac06b8fc22d16622478))
* **robust-json:** make stripTrailingCommas string-aware ([#1122](https://github.com/pedrofuentes/Council/issues/1122)) ([02272c3](https://github.com/pedrofuentes/Council/commit/02272c342d28d890bc4e5230250b574c4a0a2fca))
* **select:** thread injected sink into auto-selected InkRenderer ([1910b1f](https://github.com/pedrofuentes/Council/commit/1910b1f00964188d035b7fea030fae1dfa0787d1)), closes [#235](https://github.com/pedrofuentes/Council/issues/235) [#851](https://github.com/pedrofuentes/Council/issues/851)
* **sessions:** clarify cancel description and document delete safeguards ([6730cc9](https://github.com/pedrofuentes/Council/commit/6730cc9906d6cd10121c15990f10f536a9ba560f)), closes [#846](https://github.com/pedrofuentes/Council/issues/846) [#872](https://github.com/pedrofuentes/Council/issues/872)
* **summarizer:** guard warning sink and budget transcript on escaped size ([d55802e](https://github.com/pedrofuentes/Council/commit/d55802eb5b20a0fdd6b5cd144ef93ad33d45dc06))
* **template-migration:** sanitize + isolate on-disk YAML/schema parse failures per panel ([5c1c5f0](https://github.com/pedrofuentes/Council/commit/5c1c5f05d74988a54c05ed414bd8aa372f3946fd))
* **templates:** isolate per-template load failures in listing ([35e60e2](https://github.com/pedrofuentes/Council/commit/35e60e28c30ace34c2a217b35cca9200b5431c26)), closes [#770](https://github.com/pedrofuentes/Council/issues/770)
* **tui-convene:** use toSingleLineDisplay + sanitize registration throw + surface persister warnings ([a6113cd](https://github.com/pedrofuentes/Council/commit/a6113cdf843cb139009a864bfb4418e1b7e11b3d)), closes [#1663](https://github.com/pedrofuentes/Council/issues/1663)
* **tui-convene:** use toSingleLineDisplay + sanitize registration throw + surface persister warnings ([2496928](https://github.com/pedrofuentes/Council/commit/24969281b15040d5b9f6ce77a454ab6ef3ad82a2)), closes [#1663](https://github.com/pedrofuentes/Council/issues/1663)
* **tui-router:** extract debate transcript height into a pure helper ([8bb5e89](https://github.com/pedrofuentes/Council/commit/8bb5e899cd6f8cba5ba746d81c7285f23c57536e))
* **tui:** bound startup-crash cleanup and log swallowed unmount throw ([9303a12](https://github.com/pedrofuentes/Council/commit/9303a1246fe365a6996f3b57c439427baf8bdba5))
* **tui:** clear stale path-completion candidates on manual edit ([033453c](https://github.com/pedrofuentes/Council/commit/033453c639072ba0e7eeccb013971649243a2758)), closes [#1735](https://github.com/pedrofuentes/Council/issues/1735)
* **tui:** gate ExpertFormScreen Esc-cancel on in-flight save ([#1655](https://github.com/pedrofuentes/Council/issues/1655)) ([43c0104](https://github.com/pedrofuentes/Council/commit/43c01046d5cd4a465d90e277583b89006ced79f4))
* **tui:** harden export overlay load errors and preview race ([dea0a1e](https://github.com/pedrofuentes/Council/commit/dea0a1eb1d1869e2f251fe1db89de16e7242b017)), closes [#1694](https://github.com/pedrofuentes/Council/issues/1694)
* **tui:** harden stageDocumentFiles staging robustness ([#1634](https://github.com/pedrofuentes/Council/issues/1634)) ([c5d83fa](https://github.com/pedrofuentes/Council/commit/c5d83fad5bebbc53972e9804da655982cfa9735e))
* **tui:** ignore superseded run's late-settling continuation ([0c19232](https://github.com/pedrofuentes/Council/commit/0c19232b29f4bc72465e48772909123b1f32a257))
* **tui:** isolate bad panel templates and surface degraded mode ([#2046](https://github.com/pedrofuentes/Council/issues/2046)) ([ad40b85](https://github.com/pedrofuentes/Council/commit/ad40b858581b9709931af3f36e69fc7934cc5632))
* **tui:** isolate listTemplates failures so saved panels and not-found guidance survive ([#1817](https://github.com/pedrofuentes/Council/issues/1817)) ([e696c4e](https://github.com/pedrofuentes/Council/commit/e696c4e11f51122a4d91ff059b77c629a682cda5))
* **tui:** make ConvenePromptScreen cost estimation cancellable ([e36920a](https://github.com/pedrofuentes/Council/commit/e36920a61c44018911eb57a4bb14b29284062246)), closes [#1676](https://github.com/pedrofuentes/Council/issues/1676)
* **tui:** re-surface StartupBanner after dismiss when warnings change ([799976e](https://github.com/pedrofuentes/Council/commit/799976e483eb2cd4b598b632995b55e3b4e4f16f))
* **tui:** render training stopWarning in ExpertTrainScreen ([4f33a11](https://github.com/pedrofuentes/Council/commit/4f33a11156c6d78b723b21311202ae6136e9c6d2)), closes [#2068](https://github.com/pedrofuentes/Council/issues/2068)
* **tui:** reset startedRef on DebateStreamScreen effect cleanup ([f6f737f](https://github.com/pedrofuentes/Council/commit/f6f737f0af0c18deeeb1cb69ab0e6a65437a4841)), closes [#1677](https://github.com/pedrofuentes/Council/issues/1677)
* **tui:** surface engine stop() failure in training adapter ([7feee14](https://github.com/pedrofuentes/Council/commit/7feee14902527bed082f9d55bb2f9ac9563e0038))
* **tui:** surface panels degraded-template warnings in the TUI banner with reasons ([9857381](https://github.com/pedrofuentes/Council/commit/9857381ed2f6154ad3b4fca786a4537362cde93c)), closes [#2111](https://github.com/pedrofuentes/Council/issues/2111)
* **tui:** use aggregate COUNT for Home startup counts ([33f6d43](https://github.com/pedrofuentes/Council/commit/33f6d437eb04fcf345964d4fd74901b3aa7e57c9)), closes [#1589](https://github.com/pedrofuentes/Council/issues/1589) [#1582](https://github.com/pedrofuentes/Council/issues/1582)
* **tui:** validate live DB member cardinality (1-8) before convene specs ([a6090ee](https://github.com/pedrofuentes/Council/commit/a6090ee5f1ed2e36d187489b4792e61a3e1c38da)), closes [#1680](https://github.com/pedrofuentes/Council/issues/1680)


### Reverts

* PR [#1953](https://github.com/pedrofuentes/Council/issues/1953) convene (lint-broken committed test helper) — reopens [#1663](https://github.com/pedrofuentes/Council/issues/1663) ([8431080](https://github.com/pedrofuentes/Council/commit/8431080e947400bb948c1efc583cb05674eefe4f))

## [0.5.0](https://github.com/pedrofuentes/Council/compare/cli-v0.4.0...cli-v0.5.0) (2026-06-22)


### Features

* **cli:** export --format share for shareable panel transcripts ([#1327](https://github.com/pedrofuentes/Council/issues/1327)) ([fd36507](https://github.com/pedrofuentes/Council/commit/fd365074be9d6a481dad7c2431ae1e5f4415a8ac))
* **config:** add interactive config wizard ([8d42581](https://github.com/pedrofuentes/Council/commit/8d42581d658e2afa9dc0541bf225b1a630e88815))
* **convene:** auto-generate completed debate conclusions ([d023215](https://github.com/pedrofuentes/Council/commit/d023215b2e2ba976c3756eb0669cd75fec3a7d70))
* **convene:** prompt for interactive topics ([c3ff62c](https://github.com/pedrofuentes/Council/commit/c3ff62cff16a91b0367516311b6f748923e1b1ff))
* **demo:** add zero-setup offline council demo command ([95df14f](https://github.com/pedrofuentes/Council/commit/95df14fd8a5c18ea7fa6883bb59a35a381b266df))
* **demo:** add zero-setup offline council demo command ([#1372](https://github.com/pedrofuentes/Council/issues/1372)) ([0ebec43](https://github.com/pedrofuentes/Council/commit/0ebec43e2ebeaa59599ee8cee1f47952f86531a7))
* **demo:** list demo after doctor in the Getting Started group ([f75ff2f](https://github.com/pedrofuentes/Council/commit/f75ff2f53b27cdd7258bc1aaafb7ccb47490e12d))
* **doctor:** add privacy-safe council doctor --report ([#1352](https://github.com/pedrofuentes/Council/issues/1352)) ([42bdfb7](https://github.com/pedrofuentes/Council/commit/42bdfb7a72aa0952eab78934863aede62c585585))
* **doctor:** add sanitized --report json|markdown diagnostic ([c5db152](https://github.com/pedrofuentes/Council/commit/c5db1527dcaea9ee725aff6cbcfef2d219d87fcc))
* **doctor:** show provider availability in council doctor ([#1388](https://github.com/pedrofuentes/Council/issues/1388)) ([9887e28](https://github.com/pedrofuentes/Council/commit/9887e28a581fa888c52d7572b3a4efdb1d8468b3))
* **doctor:** surface provider availability in council doctor ([0a635ec](https://github.com/pedrofuentes/Council/commit/0a635ecf45b73b147c6769bb914797d67da3677f))
* **engine:** add provider-aware engine registry ([a19859f](https://github.com/pedrofuentes/Council/commit/a19859f92b3e4a33112cde322730f3d44a55b704))
* **engine:** add provider-aware engine registry ([638d0af](https://github.com/pedrofuentes/Council/commit/638d0afdc90fd81794208c99ea70f375a45f52ca))
* **engine:** add provider-aware engine registry ([#1369](https://github.com/pedrofuentes/Council/issues/1369)) ([587c42b](https://github.com/pedrofuentes/Council/commit/587c42bf3d8cc7394147136786e2c478860582c8))
* **export:** add polished --format share output ([b254d01](https://github.com/pedrofuentes/Council/commit/b254d013c0f9e11eced0d289b2a6bf8654e3123c))
* **panel-lint:** add `council panel lint` quality gate ([1c60561](https://github.com/pedrofuentes/Council/commit/1c60561c0d97796b2716f2359f11c6775fb1b59d))
* **panel:** add council panel lint with terminal-safe rendering ([#1320](https://github.com/pedrofuentes/Council/issues/1320)) ([c640ead](https://github.com/pedrofuentes/Council/commit/c640eaded008981ca919ba2019f7318bd9937edc))
* **panels:** add 4 official business panels (FINANCE/PEOPLE/LEGAL/EXEC) ([0032e71](https://github.com/pedrofuentes/Council/commit/0032e715a1cb518658d709cefb40dcedebcf0e9c))
* **panels:** add 4 official go-to-market panels ([8c68a9c](https://github.com/pedrofuentes/Council/commit/8c68a9ce0b9f9dab3a1d484977b3391d65faa264))
* **panels:** add finance/HR/legal/exec regulated business panels ([#1381](https://github.com/pedrofuentes/Council/issues/1381)) ([273dd99](https://github.com/pedrofuentes/Council/commit/273dd99e323cb601b9d327bd0402133f4042f8de))
* **panels:** add marketing/sales/pricing/negotiation built-in panels ([#1374](https://github.com/pedrofuentes/Council/issues/1374)) ([7b8bca9](https://github.com/pedrofuentes/Council/commit/7b8bca95d4893885c143251a8ae9d85778713a85))
* **panels:** add product/design/growth built-in panels ([8e44f1b](https://github.com/pedrofuentes/Council/commit/8e44f1b7fc2410332e3dd9f7673b105a361a5501))
* **panels:** add product/design/growth built-in panels ([#1373](https://github.com/pedrofuentes/Council/issues/1373)) ([0780d2a](https://github.com/pedrofuentes/Council/commit/0780d2a10b0204999ec132a995b3be7be396183d))
* **progress:** show setup status on stderr ([aeb9a73](https://github.com/pedrofuentes/Council/commit/aeb9a732627ca2646cd03351d157984f49a95e61))
* **review:** add `council review` to run the code-review panel over a diff ([f540727](https://github.com/pedrofuentes/Council/commit/f540727673adbd93a25138beb3f3fe2417adc717))
* **review:** add council review command for diff-based panel review ([#1412](https://github.com/pedrofuentes/Council/issues/1412)) ([048d8db](https://github.com/pedrofuentes/Council/commit/048d8db16a8f0b26af1dff762338cb40b6baf6bd))
* **site:** auto-generate CLI command reference from Commander ([#1362](https://github.com/pedrofuentes/Council/issues/1362)) ([cb3bdf1](https://github.com/pedrofuentes/Council/commit/cb3bdf1d4e8be570920ca4a804ac5cf92682ba7f))
* **telemetry:** add council telemetry command ([#1348](https://github.com/pedrofuentes/Council/issues/1348)) ([897a402](https://github.com/pedrofuentes/Council/commit/897a402bfca261acbf3e475042faaf4511fbf4a0))
* **telemetry:** implement telemetry status/enable/disable/explain commands ([58a1eab](https://github.com/pedrofuentes/Council/commit/58a1eab6abf7aab9f1f5a9da307bf920fc67c478))


### Bug Fixes

* **chat:** collapse fallback panel targets ([1c2c3df](https://github.com/pedrofuentes/Council/commit/1c2c3df727b0b6d209dd2498e50928c0a5570434))
* **chat:** collapse legacy recovery hint topics ([bc86db4](https://github.com/pedrofuentes/Council/commit/bc86db449db1522763e1862b2599e904704cd16a))
* **chat:** harden panel fallback diagnostics ([047cdd1](https://github.com/pedrofuentes/Council/commit/047cdd130bd0ea1c6978393ead679052216c36f9))
* **chat:** reload persisted auto-composed panels ([0a5fd59](https://github.com/pedrofuentes/Council/commit/0a5fd59e29e544707ced65dfe2c2b0a186a17142))
* **cli:** no import-time side effects from package entry ([2e71819](https://github.com/pedrofuentes/Council/commit/2e71819a0a0d5e6c66ac194814ba8262c8c9fcce))
* **cli:** use single-line sanitizer for terminal sinks ([7a5380c](https://github.com/pedrofuentes/Council/commit/7a5380c18d676a8817fbd5303f9387c54be1110e))
* **conclude:** render model fields as single lines ([4832567](https://github.com/pedrofuentes/Council/commit/48325671a3ffc0d1b7f89abffe764a5062155a82))
* **conclude:** sanitize plain conclusion output ([a1121c0](https://github.com/pedrofuentes/Council/commit/a1121c05de7f3268a9f3fa281ede7fe3eeead8fc))
* **config:** abort wizard on EOF and persist atomically ([75658ac](https://github.com/pedrofuentes/Council/commit/75658acc415357a2547ba4411a06a15ad428e496))
* **config:** collapse wizard display lines ([b487d3c](https://github.com/pedrofuentes/Council/commit/b487d3c79a83ddc2d5134fcc4d7351ea2b109361))
* **config:** sanitize model ids before terminal output ([e816edc](https://github.com/pedrofuentes/Council/commit/e816edc63d9b6d40247e15dc7235c9e86458a3c8))
* **config:** sanitize wizard choice errors ([7680e3c](https://github.com/pedrofuentes/Council/commit/7680e3c2d22a7e61faba51979f669a33d7bd5a40))
* **config:** sanitize wizard value display ([b114494](https://github.com/pedrofuentes/Council/commit/b11449492b774ff17f8d7c02c6fdefdcc4d271bd))
* **convene:** account auto-conclude synthesis ([c7e6289](https://github.com/pedrofuentes/Council/commit/c7e62896fe5999b660615e5fdec4c9b06928ba94))
* **convene:** document interactive topic entry ([1a07ade](https://github.com/pedrofuentes/Council/commit/1a07adeda323d5b817854ccdd8a75e7f8080d408))
* **convene:** restore topic input terminal state ([7b59319](https://github.com/pedrofuentes/Council/commit/7b59319295a1ff46bb43826a9cdcb8e0f98c7c5f))
* **doctor:** require Node 24 and diagnose Windows Copilot CLI path ([#1314](https://github.com/pedrofuentes/Council/issues/1314)) ([2f54999](https://github.com/pedrofuentes/Council/commit/2f549995446eca78c938b8ab6f68d53c58e32fef))
* **doctor:** require Node 24+ and remediate Copilot CLI path failure ([84c423d](https://github.com/pedrofuentes/Council/commit/84c423d35ccfe873e54d7159bcd34a0407f70777))
* **export:** make share output honest about unrecorded synthesis ([7eddc41](https://github.com/pedrofuentes/Council/commit/7eddc41ac848f81e7320fb124744ece67465fcd2))
* **export:** preserve debate insertion order ties ([01c2b31](https://github.com/pedrofuentes/Council/commit/01c2b318cd9a05bbeb1c64cc4e1ea53d9984330c))
* **export:** sanitize markdown renderer blockers ([1baee71](https://github.com/pedrofuentes/Council/commit/1baee71d402510601a9a0ac958b37d514bc65fdf))
* **export:** sanitize rendered transcript content ([022131c](https://github.com/pedrofuentes/Council/commit/022131cd31d33735993f0b9c464ce6e55ca695a2))
* **panel-lint:** render untrusted fields via toSingleLineDisplay ([522183c](https://github.com/pedrofuentes/Council/commit/522183ca263e2dd5979e3ad5bc010f65abb31250))
* **panel-lint:** sanitize untrusted fields in lint output ([bba5073](https://github.com/pedrofuentes/Council/commit/bba5073f451ad6b1abd757bc3d3124973fbe1b1a))
* **renderer:** label premium requests as estimate ([3e33141](https://github.com/pedrofuentes/Council/commit/3e33141137f4f277b96436181a1dcc638780b48c))
* **review:** prevent git argument injection via --base option ([321e175](https://github.com/pedrofuentes/Council/commit/321e175926ac6b041414be316488ed98c3142ab1))
* **review:** prevent git argument injection via --base option ([5f16110](https://github.com/pedrofuentes/Council/commit/5f16110772bb4e0fdac1c877d2b076d8b995acf4))
* **sanitize:** harden terminal control stripping ([56d0cee](https://github.com/pedrofuentes/Council/commit/56d0cee8c0fb43e426719cfe42ab4999cfaa13c6))
* **topic-input:** sanitize readline failure diagnostics ([b3bb7cf](https://github.com/pedrofuentes/Council/commit/b3bb7cf8f00d2d3ad8d20be5f20916ea8cb0ca01))
* **topic-input:** surface readline fallback diagnostics ([1adb56d](https://github.com/pedrofuentes/Council/commit/1adb56db9617060b62f403df5b076790c756e8ce))

## [0.4.0](https://github.com/pedrofuentes/Council/compare/cli-v0.3.0...cli-v0.4.0) (2026-06-21)


### Features

* **cli:** add Council wordmark banner renderer ([e6b35c7](https://github.com/pedrofuentes/Council/commit/e6b35c798fc2f0dfb9dcade6bea2a52cfecf55b5))
* **cli:** Council wordmark banner renderer ([#1306](https://github.com/pedrofuentes/Council/issues/1306)) ([60190b1](https://github.com/pedrofuentes/Council/commit/60190b19d33473fb4bc692d95f6794182edc1bff))
* **cli:** show banner in root help and first-run wizard ([6fb9d27](https://github.com/pedrofuentes/Council/commit/6fb9d27c09574d21df1838095169860d1cdfc232))
* **cli:** show banner in root help and first-run wizard ([#1309](https://github.com/pedrofuentes/Council/issues/1309)) ([a84f1bb](https://github.com/pedrofuentes/Council/commit/a84f1bb059c5e12e07d29cf8935c64340f61b10c))
* **doctor:** show version banner in council doctor ([e9f65d9](https://github.com/pedrofuentes/Council/commit/e9f65d97230604aa78022681ab4869051de6d15a))
* **doctor:** show version banner in council doctor ([#1308](https://github.com/pedrofuentes/Council/issues/1308)) ([54c342e](https://github.com/pedrofuentes/Council/commit/54c342e9100586d2e3ac00f3ecc06146eef7113c))

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
