import { NAMESPACE, identityDomain } from "./keypage.ts";

// POSIX sh installer. Idempotent: adds missing keys, removes revoked ones,
// changes nothing else. Verifies the SSH signature (OpenSSH 8.1+) and the lists' version header before
// touching anything. Trust on first use: the first run pins the served signer in
// ~/.ssh/tessh-signer-<username> and writes ~/.ssh/tessh-update-<username>.sh, a copy of the script with
// that signer baked in, which later runs (or cron) should use instead of `curl | sh`.
//
// The body lives in a quoted heredoc inside a function (not in `$(...)`, which old shells mis-parse), so
// the script can write that copy of itself.
const SCRIPT = `#!/bin/sh
# @@ORIGIN@@/install.sh: installs @@@USER@@'s public SSH keys.
# Adds keys that are missing, removes revoked keys, leaves every other line alone.
# Safe to run more than once. Changes nothing unless the signature checks out, and refuses key lists
# older than the last ones installed here (each list carries a version number that only goes up).
#
# Trust on first use: the first run trusts the signing key this download serves, and pins it in
# ~/.ssh/tessh-signer-@@USER@@. It also writes ~/.ssh/tessh-update-@@USER@@.sh, a copy of this script
# with that key baked in. Run that file (or put it in cron) from then on: it never trusts a key served
# over the network, as \`curl | sh\` has to. Set TESSH_SIGNER to choose the signing key yourself.
#
#   curl -fsSL @@ORIGIN@@/install.sh | sh
#   curl -fsSL @@ORIGIN@@/install.sh | sh -s -- --dry-run
#   curl -fsSL @@ORIGIN@@/install.sh | sh -s -- --file /home/deploy/.ssh/authorized_keys
set -eu

ORIGIN=@@QORIGIN@@
IDENTITY=@@QIDENTITY@@
NAMESPACE=@@QNAMESPACE@@
TESSH_USER=@@QUSER@@
SERVED_SIGNER=@@QSIGNER@@
BAKED_SIGNER=''

tessh_main() {
cat <<'TESSH_MAIN_EOF'
PIN="$HOME/.ssh/tessh-signer-$TESSH_USER"
SEQF="$HOME/.ssh/tessh-seq-$TESSH_USER"
LASTK="$HOME/.ssh/tessh-last-$TESSH_USER.keys"
LASTR="$HOME/.ssh/tessh-last-$TESSH_USER.revoked"
UPD="$HOME/.ssh/tessh-update-$TESSH_USER.sh"

AK="\${AUTHORIZED_KEYS:-$HOME/.ssh/authorized_keys}"
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY=1 ;;
    -f|--file) [ $# -ge 2 ] || { echo "install.sh: --file needs a path" >&2; exit 2; }; shift; AK="$1" ;;
    -h|--help) echo "usage: install.sh [--dry-run] [--file PATH]"; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\\n' "$*"; }
die() { printf 'install.sh: %s\\n' "$*" >&2; exit 1; }

# The target may sit in a directory another account owns (--file /home/deploy/.ssh/authorized_keys run as
# root), so never follow a link there: refuse a linked target or directory, and make every new file with mktemp.
[ -L "$AK" ] && die "$AK is a symbolic link, nothing changed. Point --file at the real file."
[ -L "$(dirname "$AK")" ] && die "$(dirname "$AK") is a symbolic link, nothing changed. Point --file at the real directory."

# 0. Which signing key to trust: TESSH_SIGNER, else the one baked into the updater, else the pinned one,
#    else (first run: trust on first use) the one this download serves.
PIN_NEW=0
if [ -n "\${TESSH_SIGNER:-}" ]; then
  SIGNER="$TESSH_SIGNER"
elif [ -n "$BAKED_SIGNER" ]; then
  SIGNER="$BAKED_SIGNER"
elif [ -f "$PIN" ]; then
  SIGNER=$(cat "$PIN")
  [ "$SIGNER" = "$SERVED_SIGNER" ] || die "the signing key for $IDENTITY changed since it was pinned in $PIN, nothing changed. If you expected this, delete $PIN and run again."
else
  SIGNER="$SERVED_SIGNER"
  PIN_NEW=1
fi
printf '%s\\n' "$SIGNER" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$' || die "the signing key is not an ssh-ed25519 public key, nothing changed"

command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen not found"
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t tessh) || die "could not create a temp dir"
trap 'rm -rf "$tmp"' EXIT INT TERM

get() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$ORIGIN/$1" -o "$tmp/$2" || die "could not download $ORIGIN/$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$tmp/$2" "$ORIGIN/$1" || die "could not download $ORIGIN/$1"
  else die "need curl or wget"; fi
}
get authorized_keys keys
get authorized_keys.sig keys.sig
get revoked revoked
get revoked.sig revoked.sig

# 1. Signature (ssh-keygen -Y, OpenSSH 8.1+). There is no fallback: an unchecked list is never installed.
printf '%s namespaces="%s" %s\\n' "$IDENTITY" "$NAMESPACE" "$SIGNER" > "$tmp/signers"
for f in keys revoked; do
  if out=$(ssh-keygen -Y verify -f "$tmp/signers" -I "$IDENTITY" -n "$NAMESPACE" -s "$tmp/$f.sig" < "$tmp/$f" 2>&1); then
    :
  else
    case "$out" in
      *"illegal option"*|*"unknown option"*|*"usage:"*|*"Usage:"*)
        die "this ssh-keygen is too old to check signatures (needs OpenSSH 8.1+), nothing changed" ;;
      *) die "signature check failed for $f, nothing changed: $out" ;;
    esac
  fi
done

# 2. Version: both signed lists start with "# tessh-keys seq=<n> updated=<date>". Refuse lists older than
#    the last ones installed here, so a replayed old list can't bring back a revoked key. At the same version
#    only the very same lists are accepted, so a second pair signed with one version can't either.
seq_of() { sed -n '1s/^# tessh-keys seq=\\([0-9][0-9]*\\) updated=[^ ]*$/\\1/p' "$1"; }
SEQ=$(seq_of "$tmp/keys")
[ -n "$SEQ" ] && [ "$SEQ" = "$(seq_of "$tmp/revoked")" ] || die "the key lists have no matching version header, nothing changed"
if [ -f "$SEQF" ]; then
  LAST=$(cat "$SEQF")
  case "$LAST" in ''|*[!0-9]*) die "$SEQF is damaged (it should hold a version number), nothing changed. Delete it to trust the served lists again." ;; esac
  [ "$SEQ" -ge "$LAST" ] || die "the served key lists (version $SEQ) are older than the ones last installed here (version $LAST), nothing changed. Someone may be replaying an old list."
  if [ "$SEQ" -eq "$LAST" ] && [ -f "$LASTK" ] && [ -f "$LASTR" ]; then
    { cmp -s "$tmp/keys" "$LASTK" && cmp -s "$tmp/revoked" "$LASTR"; } ||
      die "the served key lists say version $SEQ but differ from the version $SEQ lists installed here, nothing changed. Someone may be serving a forged list."
  fi
fi

if [ "$DRY" -eq 0 ]; then
  if [ ! -d "$HOME/.ssh" ]; then mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"; fi
  if [ "$PIN_NEW" -eq 1 ]; then
    printf '%s\\n' "$SIGNER" > "$PIN"
    say "Pinned the signing key for $IDENTITY in $PIN."
  fi
  printf '%s\\n' "$SEQ" > "$SEQF"
  cp "$tmp/keys" "$LASTK" && cp "$tmp/revoked" "$LASTR" || die "could not record the installed lists in $HOME/.ssh"
  # First run from the network: write the updater, this script with the trusted key baked in.
  if [ -z "$BAKED_SIGNER" ] && [ ! -f "$UPD" ]; then
    {
      printf '#!/bin/sh\\n'
      printf '# Updates the public SSH keys of %s. Written by install.sh with the signing key baked in,\\n' "$IDENTITY"
      printf '# so it never trusts a key served over the network. Takes the same options as install.sh.\\n'
      printf 'set -eu\\n'
      printf "ORIGIN='%s'\\n" "$ORIGIN"
      printf "IDENTITY='%s'\\n" "$IDENTITY"
      printf "NAMESPACE='%s'\\n" "$NAMESPACE"
      printf "TESSH_USER='%s'\\n" "$TESSH_USER"
      printf "SERVED_SIGNER='%s'\\n" "$SIGNER"
      printf "BAKED_SIGNER='%s'\\n" "$SIGNER"
      printf '\\ntessh_main() {\\n'
      printf "cat <<'TESSH_MAIN_EOF'\\n"
      printf '%s\\n' "$TESSH_MAIN"
      printf 'TESSH_MAIN_EOF\\n}\\n'
      printf 'TESSH_MAIN=$(tessh_main)\\n'
      printf 'eval "$TESSH_MAIN"\\n'
    } > "$UPD.tmp.$$" && chmod 700 "$UPD.tmp.$$" && mv -f "$UPD.tmp.$$" "$UPD" || die "could not write $UPD"
    say "Wrote $UPD, which keeps this signing key. To update later without trusting the network, run:"
    say "  sh $UPD"
    say "or add it to cron (crontab -e):  17 * * * * sh $UPD >/dev/null 2>&1"
  fi
fi

# 3. Work out the new file: drop revoked keys, then append missing ones. Comment lines in the lists (the
#    version header) are never copied.
if [ -f "$AK" ]; then cp "$AK" "$tmp/current"; else : > "$tmp/current"; fi
{ echo '#'; cat "$tmp/revoked"; } > "$tmp/rev"
awk -v out="$tmp/removed" '
  NR == FNR { if ($0 !~ /^#/ && NF >= 2) rev[$2] = 1; next }
  { for (i = 1; i <= NF; i++) if ($i in rev) { print > out; next } print }
' "$tmp/rev" "$tmp/current" > "$tmp/kept"
touch "$tmp/removed"
{ echo '#'; cat "$tmp/kept"; } > "$tmp/have"
awk 'NR == FNR { for (i = 1; i <= NF; i++) have[$i] = 1; next } $0 !~ /^#/ && NF >= 2 && !($2 in have)' "$tmp/have" "$tmp/keys" > "$tmp/add"

n_add=$(grep -c . "$tmp/add" || true)
n_rm=$(grep -c . "$tmp/removed" || true)
total=$(grep -c '^[^#]' "$tmp/keys" || true)

if [ "$n_add" -eq 0 ] && [ "$n_rm" -eq 0 ]; then
  say "Up to date: all $total keys are already in $AK."
  exit 0
fi
while read -r _ _ c; do say "  + \${c:-key}"; done < "$tmp/add"
while read -r line; do say "  - \${line##* }"; done < "$tmp/removed"

if [ "$DRY" -eq 1 ]; then
  say "Dry run: would add $n_add and remove $n_rm in $AK. Nothing changed."
  exit 0
fi

dir=$(dirname "$AK")
if [ ! -d "$dir" ]; then mkdir -p "$dir" && chmod 700 "$dir"; fi
backup=""
if [ -f "$AK" ]; then
  backup=$(mktemp "$AK.bak.$(date +%Y%m%d%H%M%S).XXXXXX") || die "could not create a backup of $AK, nothing changed"
  cp "$AK" "$backup" || die "could not back up $AK, nothing changed"
fi
# Written beside the target and renamed over it, so a failure midway never leaves a half-written file.
new=$(mktemp "$dir/.tessh-authorized_keys.XXXXXX") || die "could not create a temp file in $dir, nothing changed"
if cat "$tmp/kept" "$tmp/add" > "$new" && chmod 600 "$new" && mv -f "$new" "$AK"; then
  :
else
  rm -f "$new"
  die "could not write $AK\${backup:+ (the backup is $backup)}"
fi
say "Done: added $n_add, removed $n_rm in $AK.\${backup:+ Backup: $backup}"
TESSH_MAIN_EOF
}
TESSH_MAIN=$(tessh_main)
eval "$TESSH_MAIN"
`;

/** `username` must already match the username rule (`[a-z0-9-]` only). */
/** `publicURL` is the server's origin, e.g. `https://sync.example.com`. */
export function renderInstall({ username, signer }: { username: string; signer: string }, publicURL: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(username)) throw new Error("invalid username");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const origin = `${publicURL}/${username}`;
  const values: Record<string, string> = {
    "@@ORIGIN@@": origin,
    "@@USER@@": username,
    "@@QORIGIN@@": q(origin),
    "@@QIDENTITY@@": q(`${username}@${identityDomain(publicURL)}`),
    "@@QNAMESPACE@@": q(NAMESPACE),
    "@@QUSER@@": q(username),
    "@@QSIGNER@@": q(signer),
  };
  return SCRIPT.replace(/@@[A-Z]+@@/g, (k) => values[k] ?? k);
}
