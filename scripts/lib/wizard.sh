#!/usr/bin/env bash
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# wizard.sh - shared UI helpers for the interactive scripts (scripts/configure.sh, scripts/deploy-wizard.sh)
# and the extension stage files they source. Source this file; do not execute it:
#   source "$ROOT_DIR/scripts/lib/wizard.sh"
#
# Set ENV_FILE (the deploy-config .env) before calling a helper that reads or writes it. Bash 3.2 compatible
# (the macOS default): no associative arrays, no ${x,,}, integer `read -t` only, set -u-safe array expansion.
#
# Prompts always show the value that Enter keeps: the saved .env value ("current") or the default.
# Fixed choices are arrow-key menus on a terminal, and numbered menus when stdin/stdout isn't a terminal or
# VOD_WIZARD_PLAIN=1 (so scripted runs and tests can drive them). Closed stdin aborts instead of looping.

# Palette: AWS orange (#FF9900) is the one accent; status colours follow the AWS Cloudscape design system
# (info blue, success green, warning amber, error red). Truecolor when the terminal says so, else the nearest
# 256-colour codes, else the 8 basic colours. NO_COLOR (https://no-color.org) or a non-terminal turns it off.
BOLD=""; DIM=""; RESET=""; ACCENT=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
if [[ -t 1 && -z "${NO_COLOR:-}" ]] && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
  if [[ "${COLORTERM:-}" == truecolor || "${COLORTERM:-}" == 24bit ]]; then
    ACCENT=$'\033[38;2;255;153;0m'; BLUE=$'\033[38;2;83;159;229m'; GREEN=$'\033[38;2;41;173;50m'
    YELLOW=$'\033[38;2;242;183;5m'; RED=$'\033[38;2;235;87;87m'
  elif [[ "$(tput colors 2>/dev/null || echo 0)" -ge 256 ]]; then
    ACCENT=$'\033[38;5;208m'; BLUE=$'\033[38;5;74m'; GREEN=$'\033[38;5;71m'; YELLOW=$'\033[38;5;178m'; RED=$'\033[38;5;167m'
  else
    ACCENT=$'\033[33m'; BLUE=$'\033[34m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'
  fi
fi

TOTAL_STAGES="${TOTAL_STAGES:-0}"
_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs whose value changed this run
CHANGED=()        # "KEY|old|new" for each change this run (last change per key wins in the summary)
WRITTEN_SECRET=() # Secrets Manager secret names created or updated this run
SKIPPED=()        # things left to do by hand

die() { printf '  %s✕%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# _plain: true when menus must be numbered (no terminal, or VOD_WIZARD_PLAIN=1).
_plain() { [[ "${VOD_WIZARD_PLAIN:-}" == 1 || ! -t 0 || ! -t 1 ]]; }

# _read VAR [read options...]: read one line into VAR; abort (not loop) when stdin is closed.
_read() {
  local __var="$1" __line=""; shift
  IFS= read -r "$@" __line || [[ -n "$__line" ]] || die "input ended before the wizard finished; re-run it in a terminal."
  [[ -t 0 ]] || printf '\n'   # piped answers aren't echoed: keep one prompt per line
  printf -v "$__var" '%s' "$__line"
}

_trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

# _clear wipes the terminal so only the current stage is on screen. No-op when output isn't a terminal.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# _width: usable line width (the terminal's, capped at 100 so long lines stay readable).
_width() { local c; c=$(tput cols 2>/dev/null || echo 80); [[ "$c" =~ ^[0-9]+$ ]] || c=80; (( c > 100 )) && c=100; echo "$c"; }
# _rule: a thin full-width divider.
_rule() { local w r="" i; w=$(( $(_width) - 4 )); for ((i = 0; i < w; i++)); do r="${r}─"; done; printf '  %s%s%s\n' "$DIM" "$r" "$RESET"; }

# _tilde PATH: PATH with $HOME shortened to ~ (for display only).
_tilde() { local p="$1"; [[ -n "${HOME:-}" && "$p" == "$HOME"/* ]] && p="~${p#"$HOME"}"; printf '%s' "$p"; }

# _kv LABEL VALUE: one aligned "label  value" row; long values wrap under the value column.
_kv() {
  local first=true l
  while IFS= read -r l; do
    if [[ "$first" == true ]]; then printf '  %s%-10s%s  %s\n' "$DIM" "$1" "$RESET" "$l"; first=false
    else printf '  %-10s  %s\n' "" "$l"; fi
  done < <(printf '%s\n' "$2" | fold -s -w 84)
}

# banner "Title" ["One-line summary"] ["Label|value" ...]: the opening frame: an accent-barred title card,
# aligned detail rows (stages, files, next step), then the key hints.
banner() {
  _clear
  local title="$1" desc="${2:-}" row l
  shift; [[ $# -gt 0 ]] && shift
  printf '\n  %s▍%s %s%s%s\n' "$ACCENT" "$RESET" "$BOLD" "$title" "$RESET"
  if [[ -n "$desc" ]]; then
    while IFS= read -r l; do printf '  %s▍%s %s%s%s\n' "$ACCENT" "$RESET" "$DIM" "$l" "$RESET"; done \
      < <(printf '%s\n' "$desc" | fold -s -w $(( $(_width) - 6 )))
  fi
  printf '\n'
  for row in "$@"; do _kv "${row%%|*}" "${row#*|}"; done
  printf '\n'; _rule
  local menus="↑/↓ and Enter in menus"; _plain && menus="type a number in menus"
  local l
  while IFS= read -r l; do note "$l"; done \
    < <(printf '%s\n' "Enter keeps the value shown · $menus · Ctrl-C quits (re-run any time; saved values are offered again)" | fold -s -w $(( $(_width) - 4 )))
  pause "Press Enter to start ›"
}

# stage "Name": clear the screen and announce a stage with a segmented progress bar.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  local total=$TOTAL_STAGES i bar=""
  (( total < _STAGE_INDEX )) && total=$_STAGE_INDEX
  for ((i = 1; i <= total; i++)); do
    if (( i <= _STAGE_INDEX )); then bar="$bar${ACCENT}━━━━${RESET} "; else bar="$bar${DIM}────${RESET} "; fi
  done
  printf '\n  %s %s%s/%s%s\n' "$bar" "$DIM" "$_STAGE_INDEX" "$total" "$RESET"
  printf '  %s%s%s\n\n' "$BOLD" "$1" "$RESET"
}

say()  { printf '  %s\n' "$1"; }
step() { printf '  %s›%s %s\n' "$ACCENT" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s▲%s %s%s%s\n' "$YELLOW" "$RESET" "$YELLOW" "$1" "$RESET"; }

# open_url URL: open it in the browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗%s opening %s%s%s\n' "$BLUE" "$RESET" "$BLUE" "$url" "$RESET"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser; visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

# pause ["msg"]: wait for Enter.
pause() {
  local _p
  printf '\n  %s%s%s ' "$DIM" "${1:-Press Enter to continue ›}" "$RESET"
  _read _p
}

# ── .env access ──────────────────────────────────────────────────────────────────────────────

# env_get KEY: KEY's value in ENV_FILE (parsed like deployment/lib/env.sh load_env_file), or nothing.
env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  local line
  line=$(grep -E "^[[:space:]]*${1}[[:space:]]*=" "$ENV_FILE" | tail -n1) || return 0
  printf '%s' "${line#*=}" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//'
}
# _existing KEY: env_get, failing when KEY is unset or empty (kept for older callers).
_existing() { local v; v=$(env_get "$1"); [[ -n "$v" ]] || return 1; printf '%s' "$v"; }

# write_env KEY VALUE: set KEY=VALUE in ENV_FILE in place, keeping the line next to its comments.
# Replaces the active KEY= line, else un-comments a "# KEY=" placeholder, else appends. An empty VALUE
# comments the key back out (unset). No-op (and silent) when the value is unchanged.
write_env() {
  local key="$1" value="$2" old has_active=0 has_comment=0 tmp
  touch "$ENV_FILE"
  old=$(env_get "$key")
  grep -qE "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" && has_active=1
  grep -qE "^#[[:space:]]*${key}=" "$ENV_FILE" && has_comment=1
  if [[ "$old" == "$value" ]] && { [[ $has_active == 1 && -n "$value" ]] || [[ $has_active == 0 && -z "$value" ]]; }; then
    return 0
  fi
  tmp=$(mktemp "${ENV_FILE}.XXXXXX")
  K="$key" V="$value" A="$has_active" C="$has_comment" awk '
    BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; a = ENVIRON["A"] + 0; c = ENVIRON["C"] + 0; done = 0 }
    {
      line = $0; probe = line; sub(/^[ \t]+/, "", probe)
      if (probe ~ ("^" k "[ \t]*=")) {
        if (!done) { done = 1; if (v != "") print k "=" v; else if (!c) print "# " k "=" }
        next
      }
      if (!a && !done && v != "" && line ~ ("^#[ \t]*" k "=")) { done = 1; print k "=" v; next }
      print line
    }
    END { if (!done && v != "") print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  [[ "$old" == "$value" ]] && return 0  # only tidied an empty KEY= line
  WRITTEN_ENV+=("$key"); CHANGED+=("$key|$old|$value")
  if [[ -n "$value" ]]; then printf '    %s↳ saved %s=%s%s\n' "$DIM" "$key" "$value" "$RESET"
  else printf '    %s↳ cleared %s%s\n' "$DIM" "$key" "$RESET"; fi
}

# ── Validators: VALIDATOR VALUE prints a reason and fails when VALUE is invalid ───────────────

v_email() {
  [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || { echo "not an email address"; return 1; }
  case "$1" in *@example.com|*@example.org|*@example.net) echo "that's the example address; enter your own"; return 1 ;; esac
}
v_pos_int() { [[ "$1" =~ ^[1-9][0-9]*$ ]] || { echo "a positive whole number"; return 1; }; }
v_stack_name() {
  [[ "$1" =~ ^[A-Za-z][A-Za-z0-9-]*$ && ${#1} -le 100 ]] \
    || { echo "letters, digits and hyphens, starting with a letter (max 100)"; return 1; }
}
v_region() { [[ "$1" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || { echo "a Region code like eu-central-1"; return 1; }; }
# _each VALIDATOR LIST: run VALIDATOR on each comma-separated entry.
_each() {
  local fn="$1" item; local -a items=()
  IFS=, read -r -a items <<<"$2" || true   # read, not word-splitting, so '*' isn't globbed
  for item in ${items[@]+"${items[@]}"}; do item=$(_trim "$item"); [[ -n "$item" ]] || continue; "$fn" "$item" || return 1; done
}
_v_country() { [[ "$1" =~ ^[A-Za-z]{2}$ ]] || { echo "'$1' is not a 2-letter ISO country code (e.g. US,CA,GB)"; return 1; }; }
v_country_list() { _each _v_country "$1"; }
_v_cidr() {
  local o1 o2 o3 o4 len
  if [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]]; then
    o1=${BASH_REMATCH[1]}; o2=${BASH_REMATCH[2]}; o3=${BASH_REMATCH[3]}; o4=${BASH_REMATCH[4]}; len=${BASH_REMATCH[5]}
    if (( 10#$o1 <= 255 && 10#$o2 <= 255 && 10#$o3 <= 255 && 10#$o4 <= 255 && 10#$len <= 32 )); then return 0; fi
  fi
  echo "'$1' is not an IPv4 CIDR (e.g. 203.0.113.0/24)"; return 1
}
v_cidr_list() { _each _v_cidr "$1"; }
v_waf_arn() {
  [[ "$1" =~ ^arn:aws[a-z-]*:wafv2:us-east-1:[0-9]{12}:global/webacl/.+ ]] \
    || { echo "a CLOUDFRONT-scope WebACL ARN (arn:aws:wafv2:us-east-1:<account>:global/webacl/...)"; return 1; }
}
_v_origin() { [[ "$1" == '*' || "$1" =~ ^https?://[^/]+$ ]] || { echo "'$1' must be '*' or http(s)://host[:port] with no path"; return 1; }; }
v_cors_origins() { _each _v_origin "$1"; }
v_https_url() { [[ "$1" =~ ^https:// ]] || { echo "must be an https:// URL"; return 1; }; }

# ── Prompts ──────────────────────────────────────────────────────────────────────────────────

# ask_value [--optional] [--validate FN] KEY "Label" [DEFAULT]: read KEY, showing the value Enter keeps
# (the saved .env value, else DEFAULT). With --optional the value may be empty and "-" clears a saved one.
# Sets the shell variable KEY; the caller writes it (write_env) so it can post-process first.
ask_value() {
  local optional=0 validator=""
  while [[ $# -gt 0 ]]; do
    case "$1" in --optional) optional=1; shift ;; --validate) validator="$2"; shift 2 ;; *) break ;; esac
  done
  local key="$1" label="$2" def="${3:-}" cur shown="" hint="" input err
  cur=$(env_get "$key")
  if [[ -n "$cur" && -n "$validator" ]] && ! err=$("$validator" "$cur"); then
    # A placeholder copied from EXAMPLE_ENV_FILE (e.g. EMAIL=you@example.com) just means "not set yet": no warning.
    if [[ -z "${EXAMPLE_ENV_FILE:-}" || "$cur" != "$(ENV_FILE="$EXAMPLE_ENV_FILE" env_get "$key")" ]]; then
      warn "The saved $key ($cur) can't be used: $err. Enter a new value."
    fi
    cur=""
  fi
  if [[ -n "$cur" ]]; then shown="$cur"; hint="current: $cur"
  elif [[ -n "$def" ]]; then shown="$def"; hint="default: $def"
  elif (( ! optional )); then hint="required"; fi
  if (( optional )); then
    if [[ -n "$cur" ]]; then hint="$hint; - clears"; elif [[ -z "$shown" ]]; then hint="Enter skips"; fi
  fi
  while :; do
    printf '  %s?%s %s%s%s' "$ACCENT" "$RESET" "$BOLD" "$label" "$RESET"
    [[ -n "$hint" ]] && printf ' %s(%s)%s' "$DIM" "$hint" "$RESET"
    printf ' %s›%s ' "$ACCENT" "$RESET"
    _read input
    input=$(_trim "$input")
    if [[ -z "$input" ]]; then input="$shown"
    elif (( optional )) && [[ "$input" == "-" ]]; then input=""; fi
    if [[ -z "$input" ]]; then
      (( optional )) && break
      warn "a value is required"; continue
    fi
    if [[ -n "$validator" ]] && ! err=$("$validator" "$input"); then warn "${err:-not valid}"; continue; fi
    break
  done
  printf -v "$key" '%s' "$input"
}

# ask KEY "Prompt": optional free text (kept for extension stages). Shows the current value.
ask() { local p="${2%:}"; ask_value --optional "$1" "${p%[[:space:]]}"; }
# ask_default KEY "Label" DEFAULT: free text, Enter keeps the current value or DEFAULT.
ask_default() { if [[ -n "${3:-}" ]]; then ask_value "$1" "$2" "$3"; else ask_value --optional "$1" "$2"; fi; }

# ask_secret KEY "Prompt": hidden input. Never written to .env by these helpers.
ask_secret() {
  local key="$1" input
  while :; do
    printf '  %s?%s %s%s%s %s(hidden)%s %s›%s ' "$ACCENT" "$RESET" "$BOLD" "$2" "$RESET" "$DIM" "$RESET" "$ACCENT" "$RESET"
    _read input -s; printf '\n'
    [[ -n "$input" ]] && break
    warn "a value is required (input is hidden)"
  done
  printf -v "$key" '%s' "$input"
}

# _menu OUTVAR "Title" CURRENT DEFAULT "value|description"...: pick one value. The cursor starts on
# CURRENT (else DEFAULT); ● marks the saved value. An item valued __other__ (shown as "other") is returned as-is.
_menu() {
  local __out="$1" title="$2" cur="$3" def="$4"; shift 4
  local -a vals descs
  local n=0 i sel=-1 w=0 it other=-1
  for it in "$@"; do
    vals[n]="${it%%|*}"
    if [[ "$it" == *"|"* ]]; then descs[n]="${it#*|}"; else descs[n]=""; fi
    [[ "${vals[n]}" == __other__ ]] && other=$n
    (( ${#vals[n]} > w )) && w=${#vals[n]}
    n=$((n + 1))
  done
  for ((i = 0; i < n; i++)); do [[ -n "$cur" && "${vals[i]}" == "$cur" ]] && sel=$i; done
  if (( sel < 0 )) && [[ -n "$cur" ]]; then
    if (( other >= 0 )); then sel=$other; else warn "saved value '$cur' is not one of the choices"; cur=""; fi
  fi
  if (( sel < 0 )); then for ((i = 0; i < n; i++)); do [[ "${vals[i]}" == "$def" ]] && sel=$i; done; fi
  (( sel < 0 )) && sel=0

  # _line I: one menu row, without the cursor column.
  _menu_line() {
    local j="$1" v="${vals[$1]}" mark=" " tags="" label
    label="$v"; [[ "$v" == __other__ ]] && label="other"
    if [[ "$v" == "$cur" ]] || { (( j == other )) && [[ -n "$cur" ]] && ! _menu_has "$cur"; }; then mark="●"; fi
    if (( j == other )) && [[ -n "$cur" ]] && ! _menu_has "$cur"; then tags=" (current: $cur)"
    elif [[ -n "$cur" && "$v" == "$cur" ]]; then tags=" (current)"; fi
    [[ "$v" == "$def" && "$v" != "$cur" ]] && tags="$tags (default)"
    [[ "$v" == "$def" && "$v" == "$cur" ]] && tags=" (current, default)"
    printf '%s %-*s  %s%s%s%s' "$mark" "$w" "$label" "$DIM" "${descs[$1]}" "$tags" "$RESET"
  }
  _menu_has() { local k; for ((k = 0; k < n; k++)); do [[ "${vals[k]}" == "$1" ]] && return 0; done; return 1; }

  if _plain; then
    printf '  %s?%s %s%s%s\n' "$ACCENT" "$RESET" "$BOLD" "$title" "$RESET"
    for ((i = 0; i < n; i++)); do printf '   %s%2d%s  ' "$DIM" $((i + 1)) "$RESET"; _menu_line "$i"; printf '\n'; done
    local reply
    while :; do
      printf '  %sChoose 1-%s (Enter keeps %s)%s %s›%s ' "$DIM" "$n" $((sel + 1)) "$RESET" "$ACCENT" "$RESET"
      _read reply; reply=$(_trim "$reply")
      [[ -z "$reply" ]] && break
      if [[ "$reply" =~ ^[0-9]{1,3}$ ]] && (( 10#$reply >= 1 && 10#$reply <= n )); then sel=$((10#$reply - 1)); break; fi
      if _menu_has "$reply"; then for ((i = 0; i < n; i++)); do [[ "${vals[i]}" == "$reply" ]] && sel=$i; done; break; fi
      warn "enter a number from 1 to $n"
    done
  else
    local key rest
    printf '  %s?%s %s%s%s %s↑/↓ · Enter%s\n' "$ACCENT" "$RESET" "$BOLD" "$title" "$RESET" "$DIM" "$RESET"
    tput civis 2>/dev/null || true
    trap 'tput cnorm 2>/dev/null; stty echo 2>/dev/null; printf "\n"; exit 130' INT TERM
    _menu_draw() {
      local j
      for ((j = 0; j < n; j++)); do
        printf '\r\033[2K'
        if (( j == sel )); then printf '  %s%s❯ ' "$BOLD" "$ACCENT"; else printf '    '; fi
        _menu_line "$j"; printf '%s\n' "$RESET"
      done
    }
    _menu_draw
    while :; do
      IFS= read -rsn1 key || die "input ended before the wizard finished"
      case "$key" in
        $'\033')
          rest=""; IFS= read -rsn2 -t 1 rest || true
          case "$rest" in
            '[A'|'OA') sel=$(( (sel + n - 1) % n )) ;;
            '[B'|'OB') sel=$(( (sel + 1) % n )) ;;
            '') break ;;  # bare Esc: accept the highlighted (initially current) value
          esac ;;
        k|K) sel=$(( (sel + n - 1) % n )) ;;
        j|J) sel=$(( (sel + 1) % n )) ;;
        [1-9]) if (( key <= n )); then sel=$((key - 1)); fi ;;
        '') break ;;
      esac
      printf '\033[%sA' "$n"; _menu_draw
    done
    tput cnorm 2>/dev/null || true
    trap - INT TERM
    # Collapse the menu into one summary line.
    printf '\033[%sA\r\033[J' $((n + 1))
    local shown="${vals[sel]}"; [[ "$shown" == __other__ ]] && shown="other"
    printf '  %s✓%s %s %s·%s %s%s%s\n' "$GREEN" "$RESET" "$title" "$DIM" "$RESET" "$BOLD" "$shown" "$RESET"
  fi
  printf -v "$__out" '%s' "${vals[sel]}"
}

# choose [--validate FN] KEY "Title" DEFAULT "value|description"...: menu for KEY, written to .env.
# An "__other__|..." item asks for free text (checked with FN).
choose() {
  local validator=""
  if [[ "${1:-}" == --validate ]]; then validator="$2"; shift 2; fi
  local key="$1" title="$2" def="$3" pick; shift 3
  _menu pick "$title" "$(env_get "$key")" "$def" "$@"
  if [[ "$pick" == __other__ ]]; then
    if [[ -n "$validator" ]]; then ask_value --validate "$validator" "$key" "  $title"; else ask_value "$key" "  $title"; fi
  else
    printf -v "$key" '%s' "$pick"
  fi
  write_env "$key" "${!key}"
}
# ask_choice KEY "Prompt" DEFAULT allowed...: menu over literal values (kept for older callers).
ask_choice() { choose "$@"; }

# _yesno OUTVAR "Question" DEFAULT(yes|no) [YES_LABEL NO_LABEL] [TAG]: a one-line toggle.
# y/n answer at once; ←/→ (or ↑/↓, Tab) move; Enter accepts the highlighted answer.
_yesno() {
  local __out="$1" q="$2" sel="$3" yl="${4:-Yes}" nl="${5:-No}" tag="${6:-}" reply key rest
  if _plain; then
    local hint; if [[ "$sel" == yes ]]; then hint="Y/n"; else hint="y/N"; fi
    while :; do
      printf '  %s?%s %s%s%s %s(%s)%s %s›%s ' "$ACCENT" "$RESET" "$BOLD" "$q" "$RESET" "$DIM" "$hint${tag:+ $tag}" "$RESET" "$ACCENT" "$RESET"
      _read reply; reply=$(_trim "$reply")
      case "$reply" in '') break ;; [Yy]*) sel=yes; break ;; [Nn]*) sel=no; break ;; esac
      [[ "$reply" == "$yl" ]] && { sel=yes; break; }
      [[ "$reply" == "$nl" ]] && { sel=no; break; }
      warn "answer y or n"
    done
  else
    _yesno_draw() {
      printf '\r\033[2K  %s?%s %s%s%s   ' "$ACCENT" "$RESET" "$BOLD" "$q" "$RESET"
      if [[ "$sel" == yes ]]; then printf '%s%s● %s%s   %s○ %s%s' "$BOLD" "$ACCENT" "$yl" "$RESET" "$DIM" "$nl" "$RESET"
      else printf '%s○ %s%s   %s%s● %s%s' "$DIM" "$yl" "$RESET" "$BOLD" "$ACCENT" "$nl" "$RESET"; fi
      if [[ -n "$tag" ]]; then printf '   %s%s%s' "$DIM" "$tag" "$RESET"; fi
    }
    tput civis 2>/dev/null || true
    trap 'tput cnorm 2>/dev/null; stty echo 2>/dev/null; printf "\n"; exit 130' INT TERM
    _yesno_draw
    while :; do
      IFS= read -rsn1 key || die "input ended before the wizard finished"
      case "$key" in
        [Yy]) sel=yes; break ;;
        [Nn]) sel=no; break ;;
        $'\t'|h|l|j|k) if [[ "$sel" == yes ]]; then sel=no; else sel=yes; fi ;;
        $'\033') rest=""; IFS= read -rsn2 -t 1 rest || true
          case "$rest" in '[A'|'[B'|'[C'|'[D'|'OA'|'OB'|'OC'|'OD') if [[ "$sel" == yes ]]; then sel=no; else sel=yes; fi ;; '') break ;; esac ;;
        '') break ;;
      esac
      _yesno_draw
    done
    tput cnorm 2>/dev/null || true
    trap - INT TERM
    local ans; if [[ "$sel" == yes ]]; then ans="$yl"; else ans="$nl"; fi
    printf '\r\033[2K  %s✓%s %s %s·%s %s%s%s\n' "$GREEN" "$RESET" "$q" "$DIM" "$RESET" "$BOLD" "$ans" "$RESET"
  fi
  printf -v "$__out" '%s' "$sel"
}

# confirm "Question": yes/no gate defaulting to No.
confirm() { local a; _yesno a "$1" no; [[ "$a" == yes ]]; }
# confirm_yes "Question?": yes/no gate where Enter means Yes (for recommended steps).
confirm_yes() { local a; _yesno a "$1" yes; [[ "$a" == yes ]]; }
# confirm_state "Question" yes|no: yes/no gate defaulting to the saved state, so Enter on a re-run keeps it.
confirm_state() {
  local a tag=""; [[ "${2:-no}" == yes ]] && tag="(currently on)"
  _yesno a "$1" "${2:-no}" Yes No "$tag"; [[ "$a" == yes ]]
}

# toggle KEY "Feature" DEFAULT ON_VALUE OFF_VALUE [ON_LABEL OFF_LABEL]: on/off menu for KEY, written to .env.
toggle() {
  local key="$1" q="$2" def="$3" onv="$4" offv="$5" onl="${6:-$4}" offl="${7:-$5}" cur tag d a
  cur=$(env_get "$key")
  if [[ "$cur" == "$onv" || "$cur" == "$offv" ]]; then tag="(current)"; else cur="$def"; tag="(default)"; fi
  if [[ "$cur" == "$onv" ]]; then d=yes; else d=no; fi
  _yesno a "$q" "$d" "$onl" "$offl" "$tag"
  if [[ "$a" == yes ]]; then printf -v "$key" '%s' "$onv"; else printf -v "$key" '%s' "$offv"; fi
  write_env "$key" "${!key}"
}
# on_off KEY "Feature" DEFAULT(ON|OFF)
on_off() { toggle "$1" "$2" "$3" ON OFF; }
# true_false KEY "Feature" DEFAULT(true|false)
true_false() { toggle "$1" "$2" "$3" true false Yes No; }

# ── AWS ──────────────────────────────────────────────────────────────────────────────────────

# put_secret NAME: create or update a Secrets Manager secret in $AWS_REGION from stdin (the value is
# never echoed or put on argv).
put_secret() {
  local name="$1"
  if aws secretsmanager describe-secret --region "$AWS_REGION" --secret-id "$name" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --region "$AWS_REGION" --secret-id "$name" \
      --secret-string file:///dev/stdin >/dev/null && printf '  %s✓ updated secret%s %s\n' "$GREEN" "$RESET" "$name"
  else
    aws secretsmanager create-secret --region "$AWS_REGION" --name "$name" \
      --secret-string file:///dev/stdin >/dev/null && printf '  %s✓ created secret%s %s\n' "$GREEN" "$RESET" "$name"
  fi
  WRITTEN_SECRET+=("$name")
}

# ── Summary ──────────────────────────────────────────────────────────────────────────────────

# show_changes: list each key changed this run as old → new (last change per key).
show_changes() {
  local entry k o v seen=","
  if (( ${#CHANGED[@]} == 0 )); then note "No changes to $ENV_FILE."; return 0; fi
  say "${BOLD}Changed in $(_tilde "$ENV_FILE")${RESET}"
  local i
  for ((i = ${#CHANGED[@]} - 1; i >= 0; i--)); do
    entry="${CHANGED[i]}"; k="${entry%%|*}"; entry="${entry#*|}"; o="${entry%%|*}"; v="${entry#*|}"
    [[ "$seen" == *",$k,"* ]] && continue
    seen="$seen$k,"
    printf '    %-28s %s%s →%s %s\n' "$k" "$DIM" "${o:-(unset)}" "$RESET" "${v:-(unset)}"
  done
}

# finish ["Title"]: closing summary of what changed and anything left to do by hand.
finish() {
  _clear
  printf '\n  %s▍%s %s%s✓ %s%s\n\n' "$ACCENT" "$RESET" "$BOLD" "$GREEN" "${1:-Done}" "$RESET"
  show_changes
  (( ${#WRITTEN_SECRET[@]} )) && note "Secrets created/updated: ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "Still to do by hand:"
    local s; for s in "${SKIPPED[@]}"; do step "$s"; done
  fi
  printf '\n'
}
