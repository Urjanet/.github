#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

# -----------------------------------------------------------------------------
# updaterunner.sh
# A flexible launcher for urjanet.think.update.UpdateRunner
# - Dynamically builds CLASSPATH from provided lib dirs (and sane defaults)
# - Allows overriding JAVA_HOME, JAVA_OPTS, native lib path, config file
# - Pass-through for UpdateRunner args after --
# -----------------------------------------------------------------------------

print_usage() {
  cat <<'EOF'
Usage:
  updaterunner.sh [options] -- [UpdateRunner args]

Options:
  --lib-dir DIR            Add a directory to scan for JARs (repeatable)
  --classes-dir DIR        Add a directory of compiled classes (repeatable)
  --java-home DIR          Use a specific JAVA_HOME
  --java-opts "OPTS"        JVM options (default: -Xms1024m -Xmx2048m)
  --native-lib-path PATHS  Set -Djava.library.path (':'-separated)
  --config FILE            Set -Durjanet.config.file (default: development.json)
  --class NAME             Main class (default: urjanet.think.update.UpdateRunner)
  --skip-prefix PREFIX     Skip jars whose basename starts with PREFIX (repeatable)
  --extra-java-arg ARG     Add a raw extra JVM arg (repeatable)
  -h, --help               Show this help

Notes:
  - All arguments after -- are passed to UpdateRunner unchanged (e.g., -c, -i, -highlight).
  - You can also set environment variables: JAVA_OPTS, EXTRA_JAVA_ARGS, URJANET_CONFIG.
Examples:
  ./updaterunner.sh \
    --lib-dir /opt/platform2/lib \
    --lib-dir /opt/platform2/lib/thirdparty \
    --lib-dir /path/to/someother/lib \
    --config /path/to/development.json \
    -- -- -c CASS_100888-EnergirCAN_1 -i source_type=PDF -i acquisition_type=LOCAL_FILE -highlight
EOF
}

# --- Resolve APP_HOME from this script's location (../ of script dir) ---------
resolve_app_home() {
  local script_file
  if command -v readlink >/dev/null 2>&1 && readlink -f / >/dev/null 2>&1; then
    script_file="$(readlink -f "${BASH_SOURCE[0]}")"
  else
    # Fallback: best-effort resolution without -f
    local prg="${BASH_SOURCE[0]}"
    while [ -h "$prg" ]; do
      local ls_out link
      ls_out=$(ls -ld "$prg")
      link=$(expr "$ls_out" : '.*-> \(.*\)$')
      if expr "$link" : '/.*' >/dev/null; then
        prg="$link"
      else
        prg="$(dirname "$prg")/$link"
      fi
    done
    script_file="$(cd -- "$(dirname -- "$prg")" >/dev/null 2>&1 && pwd -P)/$(basename -- "$prg")"
  fi
  local script_dir
  script_dir="$(cd -- "$(dirname -- "$script_file")" >/dev/null 2>&1 && pwd -P)"
  APP_HOME="$(cd -- "$script_dir/.." >/dev/null 2>&1 && pwd -P)"
}

# --- Small helpers ------------------------------------------------------------
die() { echo "Error: $*" >&2; exit 1; }
info() { echo "[updaterunner] $*" >&2; }

# --- Defaults ----------------------------------------------------------------
resolve_app_home

# Default lib/class dirs; you can extend via --lib-dir / --classes-dir
LIB_DIRS=(
  "$APP_HOME/lib"
  "/opt/platform2/lib"
  "/opt/platform2/lib/thirdparty"
  "/opt/platform2/lib/thirdParty"
)
CLASSES_DIRS=(
  "$APP_HOME/bin"
  "$APP_HOME/build/classes/java/main"
  "$APP_HOME/build/classes/main/java"
)

CONFIG_FILE="${URJANET_CONFIG:-development.json}"
JAVA_OPTS="${JAVA_OPTS:--Xms1024m -Xmx2048m}"
MAIN_CLASS="${MAIN_CLASS:-urjanet.think.update.UpdateRunner}"
JAVA_LIBRARY_PATH_DEFAULT=(
  "/opt/urjanet_infra/deployment/pdflib/64-bit"
  "/opt/urjanet_infra/deployment/pdflib/tet-5-3"
)
JAVA_LIBRARY_PATH="${JAVA_LIBRARY_PATH:-}"
EXTRA_JAVA_ARGS="${EXTRA_JAVA_ARGS:-}"

# Skip jars that start with these prefixes (to avoid duplicates/older variants)
SKIP_PREFIXES=( "templates" "domain-uds" "domain-common" "urjacommon" )

# --- Parse CLI options --------------------------------------------------------
UPDATE_RUNNER_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --lib-dir)
      [[ $# -ge 2 ]] || die "--lib-dir requires DIR"
      LIB_DIRS+=("$2"); shift 2;;
    --classes-dir)
      [[ $# -ge 2 ]] || die "--classes-dir requires DIR"
      CLASSES_DIRS+=("$2"); shift 2;;
    --java-home)
      [[ $# -ge 2 ]] || die "--java-home requires DIR"
      JAVA_HOME="$2"; shift 2;;
    --java-opts)
      [[ $# -ge 2 ]] || die "--java-opts requires a value"
      JAVA_OPTS="$2"; shift 2;;
    --native-lib-path)
      [[ $# -ge 2 ]] || die "--native-lib-path requires PATHS"
      JAVA_LIBRARY_PATH="$2"; shift 2;;
    --config)
      [[ $# -ge 2 ]] || die "--config requires FILE"
      CONFIG_FILE="$2"; shift 2;;
    --class)
      [[ $# -ge 2 ]] || die "--class requires NAME"
      MAIN_CLASS="$2"; shift 2;;
    --skip-prefix)
      [[ $# -ge 2 ]] || die "--skip-prefix requires PREFIX"
      SKIP_PREFIXES+=("$2"); shift 2;;
    --extra-java-arg)
      [[ $# -ge 2 ]] || die "--extra-java-arg requires ARG"
      EXTRA_JAVA_ARGS+=" $2"; shift 2;;
    -h|--help)
      print_usage; exit 0;;
    --)
      shift
      UPDATE_RUNNER_ARGS+=("$@")
      break;;
    *)
      UPDATE_RUNNER_ARGS+=("$1"); shift;;
  esac
done

# --- Determine Java command ---------------------------------------------------
if [[ -n "${JAVA_HOME:-}" ]]; then
  if [[ -x "$JAVA_HOME/jre/sh/java" ]]; then
    JAVACMD="$JAVA_HOME/jre/sh/java"
  else
    JAVACMD="$JAVA_HOME/bin/java"
  fi
  [[ -x "$JAVACMD" ]] || die "JAVA_HOME is set but java not found at $JAVACMD"
else
  JAVACMD="java"
  command -v "$JAVACMD" >/dev/null 2>&1 || die "JAVA_HOME not set and 'java' not found in PATH"
fi

# --- Build classpath ----------------------------------------------------------
# Collect candidate entries (jars and classes dirs), applying skip rules and dedup
declare -a CP_ENTRIES

# Add classes dirs if they exist
for dir in "${CLASSES_DIRS[@]}"; do
  [[ -d "$dir" ]] && CP_ENTRIES+=("$dir") || true
done

# Helper: check if jar should be skipped by prefix
should_skip_jar() {
  local base="$1"
  for prefix in "${SKIP_PREFIXES[@]}"; do
    if [[ "$base" == "$prefix"* ]]; then
      return 0
    fi
  done
  return 1
}

# Use find to gather jars under each lib dir (non-recursive depth 2 is usually enough)
for libdir in "${LIB_DIRS[@]}"; do
  [[ -d "$libdir" ]] || continue
  while IFS= read -r -d '' jar; do
    base="$(basename -- "$jar")"
    if should_skip_jar "$base"; then
      continue
    fi
    CP_ENTRIES+=("$jar")
  done < <(find "$libdir" -maxdepth 2 -type f -name '*.jar' -print0 2>/dev/null)
  # Also include the libdir itself if it has classes
  if [[ -d "$libdir" ]]; then
    CP_ENTRIES+=("$libdir")
  fi
done

# Deduplicate while preserving order
declare -A seen
declare -a CP_UNIQUE
for entry in "${CP_ENTRIES[@]:-}"; do
  # Normalize path
  if [[ -d "$entry" || -f "$entry" ]]; then
    entry="$(cd -- "$(dirname -- "$entry")" >/dev/null 2>&1 && pwd -P)/$(basename -- "$entry")"
  fi
  if [[ -z "${seen[$entry]:-}" ]]; then
    seen[$entry]=1
    CP_UNIQUE+=("$entry")
  fi
done

# Join with ':'
CLASSPATH=$(IFS=:; echo "${CP_UNIQUE[*]:-}")
[[ -n "$CLASSPATH" ]] || die "Empty classpath. Provide --lib-dir with your jars."

# --- Compose native library path ---------------------------------------------
if [[ -z "${JAVA_LIBRARY_PATH:-}" ]]; then
  # Use defaults that commonly exist; filter those that exist
  declare -a LIBPATH_ENTRIES
  for d in "${JAVA_LIBRARY_PATH_DEFAULT[@]}"; do
    [[ -d "$d" ]] && LIBPATH_ENTRIES+=("$d") || true
  done
  if [[ ${#LIBPATH_ENTRIES[@]} -gt 0 ]]; then
    JAVA_LIBRARY_PATH=$(IFS=:; echo "${LIBPATH_ENTRIES[*]}")
  else
    JAVA_LIBRARY_PATH=""
  fi
fi

# --- Launch ------------------------------------------------------------------
CMD=("$JAVACMD")
# JVM opts
if [[ -n "$JAVA_OPTS" ]]; then
  # shellcheck disable=SC2206 # intentional word-splitting of JAVA_OPTS
  CMD+=( $JAVA_OPTS )
fi
if [[ -n "$EXTRA_JAVA_ARGS" ]]; then
  # shellcheck disable=SC2206 # intentional word-splitting of EXTRA_JAVA_ARGS
  CMD+=( $EXTRA_JAVA_ARGS )
fi
CMD+=("-Dsun.awt.disablegrab=true")
CMD+=("-Durjanet.config.file=$CONFIG_FILE")
if [[ -n "$JAVA_LIBRARY_PATH" ]]; then
  CMD+=("-Djava.library.path=$JAVA_LIBRARY_PATH")
fi
CMD+=("-classpath" "$CLASSPATH")
CMD+=("$MAIN_CLASS")
# Pass-through UpdateRunner args
if [[ ${#UPDATE_RUNNER_ARGS[@]} -gt 0 ]]; then
  CMD+=("${UPDATE_RUNNER_ARGS[@]}")
fi

info "Using APP_HOME=$APP_HOME"
info "Using JAVA: $JAVACMD"
info "Classpath entries: ${#CP_UNIQUE[@]}"

exec "${CMD[@]}"
