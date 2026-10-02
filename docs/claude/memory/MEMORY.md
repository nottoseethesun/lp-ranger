# Memory Index

Durable LP Ranger knowledge **not derivable from the code** — scan hooks, open only what you need. This file holds the rules for HOW to work (`feedback_*`), and is loaded every session.

**State and open items live in [PROJECT-STATE.md](PROJECT-STATE.md)**, which is not auto-loaded. Open it before any status report, audit, release or burn-in write-up, and before proposing a change to an area it covers. New `project_*` and `reference_*` pointers go there; new `feedback_*` pointers go here.

`CLAUDE.md` covers architecture; `private/` is machine-local, `archive/` is resolved history. New here? Read [renamed lp ranger](project_renamed_lp_ranger.md) first.

## Workflow, git, CI & testing
- [always build](feedback_always_build.md) — Edited public/? Run `npm run build`
- [branching](feedback_branching.md) — Never push to main: branch + PR, ONE branch at a time
- [check before push](feedback_check_before_push.md) — Full local lint+test+coverage before every push
- [check both Node versions](feedback_check_both_node_versions.md) — `npm run check` runs one Node; CI runs 22 and 24. Run the suite under 22 too
- [ci protocol](feedback_ci_protocol.md) — Never skip the local merge-to-main check
- [full repo grep](feedback_full_repo_grep.md) — Renames and pattern audits grep the WHOLE repo
- [git workflow](feedback_git_workflow.md) — No push/merge/rebase/delete-branch/release without OK
- [never revert cache-bust stamps](feedback_never_revert_cache_bust_stamps.md) — The `?v=` stamp IS the invalidation; ship it
- [never stash to compare](feedback_never_stash_to_compare.md) — Use a worktree, never `git stash`
- [never pattern-kill](feedback_never_pattern_kill.md) — pkill -f kills the caller; kill by port
- [no flaky push](feedback_no_flaky_push.md) — Fix flaky tests before CI sees them
- [no npx](feedback_no_npx.md) — Never npx; check package.json first
- [Edit tool, not python](feedback_edit_tool_not_python.md) — Patch with Edit/Write, never python3 or sed
- [npm script 100-char threshold](feedback_npm_script_100_char_threshold.md) — Inline npm commands over 100 chars move to scripts/
- [one lint target list](feedback_one_lint_target_list.md) — File lists live only in scripts/lint-targets.js
- [regenerate lockfile](feedback_regenerate_lockfile.md) — Advisories: stop server, delete lockfile + node_modules, `npm i` first
- [test commands](feedback_test_commands.md) — Never raw `node --test`; wrap anything loading `src/` in wipe/restore-settings
- [use linter to locate issues](feedback_use_linter_to_locate_issues.md) — Run the linter to find where a rule fires; don't guess
- [tag format, no v](project_tag_format_no_v.md) — Strict semver; latest tag needs `--sort=-v:refname` plus `grep -v '^v'`

## How to work with the user
- [bug only if current stack breaks](feedback_bug_only_if_current_stack_breaks.md) — Not a bug if only a hypothetical stack fails
- [burn-in probe](feedback_burn_in_probe.md) — Ask "anything felt off, even small?"
- [chat, don't AskUserQuestion](feedback_chat_dont_askuserquestion.md) — Open-ended discussion wants plain chat
- [don't modify tested code before commit](feedback_dont_modify_tested_code_before_commit.md) — User tested it → commit exactly that
- [fix only what was asked](feedback_fix_only_what_was_asked.md) — "Fix X" changes only X; no adjacent sweeps
- [flag operational side effects](feedback_flag_operational_side_effects.md) — Flag restarts; never say hard-reload
- [hardening minimal scope](feedback_hardening_minimal_scope.md) — Hardening = no refactor beyond the fix
- [nice-to-haves are not bugs](feedback_nice_to_haves_not_bugs.md) — Such lists need a "not bugs" note
- [no finding without a failure](feedback_no_finding_without_a_failure.md) — Can't say what breaks? Delete it; "inert" means delete
- [lead with open bugs](feedback_lead_with_open_bugs.md) — Open bugs are the FIRST line; record each one durably at once
- [no internal constants in design talk](feedback_no_internal_constants_in_design_talk.md) — Operator-facing behavior, not implementation constants
- [operator sees UI, not logs](feedback_operator_sees_ui_not_logs.md) — Answer in badge/dialog terms; the log is your instrument
- [PLS/wPLS interchangeable](feedback_pls_wpls_interchangeable.md) — Don't ask which
- [one thing at a time](feedback_one_thing_at_a_time.md) — Only what was asked; yes/no means yes/no
- [don't chase downstream symptoms](feedback_dont_chase_downstream_symptoms.md) — A symptom mid-fix is information, not a work order
- [don't invent a requirement](feedback_dont_invent_a_requirement.md) — A guard protecting a guard means step one was wrong
- [general to specific](feedback_general_to_specific.md) — Open by naming the thing in operator terms
- [explain behavior, not call sites](feedback_explain_behavior_not_call_sites.md) — Say what happens and what a reader would see; function names come last, if at all
- [prose style](feedback_prose_style.md) — Short sentences, no slop words, spell out small numbers, lowercase tech initials, no gwei
- [distinct terms for distinct things](feedback_distinct_terms_for_distinct_things.md) — One word per entity; no ambiguous pronouns
- [release notes style](feedback_release_notes_style.md) — Old West gunslinger + one-line summary; consequences, not changes — but "fixes bug" already is one
- [revert means code](feedback_revert_means_code.md) — "Revert" = repo edits only, never the plan
- [take up minor cleanups](feedback_take_up_minor_cleanups.md) — Take up small cleanups noticed in review
- [try before commit](feedback_try_before_commit.md) — Browser-observable changes wait for sign-off
- [user launches app](feedback_user_launches_app.md) — The user launches it during manual testing
- [wait for sign-off](feedback_wait_for_signoff.md) — Offered options mean WAIT
- [instrument before inferring](feedback_instrument_before_inferring.md) — Two wrong models = add logging, stop guessing
- [grep before writing](feedback_grep_before_writing.md) — Grep existing usage before coding to a shape or API
- [tests cover full contract before manual](feedback_tests_cover_full_contract_before_manual.md) — Cover the user-visible contract first
- [always test a regression](feedback_always_test_a_regression.md) — Prove the test fails without the fix
- [tests with implementation](feedback_tests_with_implementation.md) — Write tests as you implement
- [use the path being tested](feedback_use_the_path_being_tested.md) — Validate through the exact entry point
- [prove the revert applied](feedback_prove_the_revert_applied.md) — A silently-failed revert reports green
- [verify runtime before rediagnosing](feedback_verify_runtime_before_rediagnosing.md) — "Still broken" but green? Check what's actually running
- [verify before claiming](feedback_verify_before_claiming.md) — Run the falsifying check; a partial sample proves nothing
- [audit before declaring done](feedback_audit_before_declaring_done.md) — Re-read the rules and audit state + sequence before saying done; a green check is not sufficient
- [verify symbols a comment names](feedback_verify_symbols_a_comment_names.md) — Grep every symbol a comment names
- [check state before explaining design](feedback_check_state_before_explaining_design.md) — "Why does it do X?" → check PROJECT-STATE for a known-duplication entry before calling X deliberate

## Engineering, code, UI & docs rules
- [audit program state](feedback_audit_program_state.md) — Audit for needless state; derive from what exists
- [basic fix first](feedback_basic_fix_first.md) — Look for a one-line or reordering fix first
- [defense in depth must be slower](feedback_defense_in_depth_must_be_slower.md) — A backup must be strictly slower than the primary
- [dotenv/api-keys not layered](feedback_dotenv_apikeys_not_for_layered_pattern.md) — `.env` stays outside the layered-defaults pattern
- [EIP-55 checksum URL segments](feedback_eip55_checksum_url_segments.md) — Addresses checksummed, URL segments included
- [engineering invariants](feedback_engineering_invariants.md) — Never break single-source-of-truth or singletons for expedience
- [signal substitution](feedback_signal_substitution.md) — Test the thing asked about, not a cheaper proxy
- [event origin vs viewed tab](feedback_event_origin_vs_viewed_tab.md) — Label from the event's origin, not the viewed tab
- [explicit null/undefined checks](feedback_explicit_null_undefined_checks.md) — Write the checks; never lean on coercion
- [finish logic](feedback_finish_logic.md) — Trace every path to completion before calling it done
- [keep browser logs](feedback_keep_browser_logs.md) — Dashboard console.log is permanent
- [KISS](feedback_kiss.md) — One clean heuristic beats layered complexity
- [logging](feedback_logging.md) — Token symbols, NFT id + emoji, full context on every move
- [minimize caching](feedback_minimize_caching.md) — No new caching layers; reuse existing resolvers
- [generic chain cache keys](feedback_generic_chain_cache_keys.md) — Key chain caches generically (e.g. by pool) so all positions share
- [module self-announcement](feedback_module_self_announcement.md) — A module announces itself; B doesn't reach into A
- [Moralis first](feedback_moralis_first.md) — Moralis is primary for historical prices when a key exists
- [multiline comment style](feedback_multiline_comment_style.md) — `/*- ... */` over stacked `//`
- [JSDoc style](feedback_jsdoc_style.md) — What it does, how it works, how it integrates: one flowing argument, terms defined before use, never a bug post-mortem
- [never compact code](feedback_never_compact_code.md) — Extract a file; don't compress to fit max-lines
- [no delay patches](feedback_no_delay_patches.md) — Never setTimeout where flow control belongs
- [no duplication](feedback_no_duplication.md) — Fetch once, pass it down; extract the pure part both tiers import
- [no computation in params](feedback_no_computation_in_params.md) — Hoist any await/lookup out of an argument
- [no extra state](feedback_no_extra_state.md) — No new tracker/Map/flag when existing state can serve
- [no genesis chain scans](feedback_no_genesis_chain_scans.md) — Every getLogs scan needs a tight lower bound
- [no global monkey-patch](feedback_no_global_monkey_patch.md) — Never modify JS globals
- [no heuristic thresholds](feedback_no_heuristic_thresholds.md) — No heuristic dollar amounts guarding logic
- [no junk repair code](feedback_no_junk_repair_code.md) — "Backfill" is banned; no repair/migration heaped on
- [never clear to force a recompute](feedback_never_clear_to_force_a_recompute.md) — Ask for the rebuild with a flag; overwrite, never delete first
- [don't persist a correction](feedback_dont_persist_a_correction.md) — Ask whether the wrong value should be written at all
- [no lazy loading](feedback_no_lazy_loading.md) — No `require()` inside functions
- [no re-exports](feedback_no_reexports.md) — Import from the owning module
- [unused exports are fine](feedback_unused_exports_are_fine.md) — An export nothing imports yet is composability, not a gap; never a finding, never deleted for knip
- [one literal per shipped default](feedback_one_literal_per_shipped_default.md) — One literal per config value, in the defaults file
- [price API, no pool](feedback_price_api_no_pool.md) — Let the price service pick the pool
- [slippage lowest floor](feedback_slippage_lowest_floor.md) — `_bestAttemptError` taking the LOWEST impact is intentional
- [think ahead](feedback_think_ahead.md) — Consider fetch → cache → invalidate → incremental first
- [trace patterns first](feedback_trace_patterns_first.md) — UI bugs: check existing guard/flag systems first
- [trace semantic coherence](feedback_trace_semantic_coherence.md) — Trace a display convention end-to-end
- [util subdir per utility](feedback_util_subdir_per_utility.md) — Two or more files becomes a directory with index.js
- [canonical info icon](feedback_canonical_info_icon.md) — Circle-i is `.9mm-pos-mgr-il-info-btn` + a literal "i"
- [CSS rules](feedback_css_rules.md) — No inline styles, no zoom, no !important; name colors
- [help cursor on title](feedback_help_cursor_on_title.md) — An inert element with a title shows the help cursor
- [inline-edit dialog button set](feedback_inline_edit_dialog_button_set.md) — Save / Return to Automatic X / Cancel, distinct styling
- [no classList for state](feedback_no_classlist_for_state.md) — Never read the DOM to determine program state
- [no data in presentation](feedback_no_data_in_presentation.md) — No defaults, config or business data in HTML/CSS
- [validate in the core, not the UI](feedback_validate_in_the_core_not_the_ui.md) — Bounds go on the server; one core, many frontends
- [no HTML in Markdown](feedback_no_html_in_markdown.md) — Pure Markdown, no inline HTML (MD033)
- [no new HTML in JS](feedback_no_new_html_in_js.md) — No interpolated innerHTML in dashboard JS
- [sound gate scope](feedback_sound_gate_scope.md) — Jingles gated on the browser idle timer is correct
- [help page](project_help_page.md) — Help lives at /help.html with its own CSS
