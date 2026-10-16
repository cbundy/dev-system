#!/usr/bin/env bash
# Probes how the installed gh lays out and writes its config, using only a
# scratch GH_CONFIG_DIR and fake tokens. It never logs in, refreshes, logs out
# or talks to GitHub with a real token: every command here is local
# (`gh config set`, `gh auth token`, `gh auth switch`).
#
#   bash probe-gh-config.sh > probe-gh-config.out 2>&1
set -u

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# Keep gh off the real config, state and token, and off the network.
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GH_HOST
export XDG_STATE_HOME="$scratch/state" XDG_DATA_HOME="$scratch/data" XDG_CACHE_HOME="$scratch/cache"
export GH_TELEMETRY=0 GH_NO_UPDATE_NOTIFIER=1 GH_PROMPT_DISABLED=1
fake_a="gho_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
fake_b="gho_FAKEbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

say() { printf '\n## %s\n' "$*"; }
listing() { (cd "$1" && find . -mindepth 1 -printf '%p %y %m %s inode=%i\n' | sort); }
seed_hosts() { # <file> <active user> : two fake accounts, the shape gh 2.40+ writes
  cat > "$1" <<EOF
github.com:
    users:
        alice:
            oauth_token: $fake_a
        bob:
            oauth_token: $fake_b
    git_protocol: https
    oauth_token: $( [ "$2" = alice ] && echo "$fake_a" || echo "$fake_b" )
    user: $2
EOF
  chmod 600 "$1"
}
which_token() { # prints which fake account's token gh returns, never the token
  local t
  t=$(gh auth token --hostname github.com 2>&1)
  case "$t" in
    "$fake_a") echo alice ;;
    "$fake_b") echo bob ;;
    "") echo "(empty)" ;;
    *) echo "error: $(echo "$t" | head -n 1 | cut -c1-80)" ;;
  esac
}

say "gh version"
gh --version | head -n 1

say "1. What a config write creates in an empty GH_CONFIG_DIR"
export GH_CONFIG_DIR="$scratch/gh1"
gh config set prompt disabled
listing "$GH_CONFIG_DIR"
echo "state dir (XDG_STATE_HOME/gh), outside GH_CONFIG_DIR:"
listing "$XDG_STATE_HOME" 2>/dev/null || echo "(none)"

say "2. hosts.yml holds the login; the token is read from it with no keyring"
seed_hosts "$GH_CONFIG_DIR/hosts.yml" alice
echo "gh auth token returns: $(which_token)"

say "3. A hosts.yml write is in place (same inode), not temp file + rename"
before=$(stat -c %i "$GH_CONFIG_DIR/hosts.yml")
gh config set -h github.com git_protocol ssh
after=$(stat -c %i "$GH_CONFIG_DIR/hosts.yml")
echo "inode before=$before after=$after $([ "$before" = "$after" ] && echo SAME || echo CHANGED)"
grep -q 'git_protocol: ssh' "$GH_CONFIG_DIR/hosts.yml" && echo "hosts.yml updated"
before=$(stat -c %i "$GH_CONFIG_DIR/hosts.yml")
gh auth switch --hostname github.com --user bob >/dev/null 2>&1
after=$(stat -c %i "$GH_CONFIG_DIR/hosts.yml")
echo "gh auth switch: inode $([ "$before" = "$after" ] && echo SAME || echo CHANGED), active token now: $(which_token)"
echo "config.yml untouched by host writes? $(grep -c git_protocol "$GH_CONFIG_DIR/config.yml") git_protocol line(s) in config.yml (the global default)"

say "4. hosts.yml as a symlink into another directory (login split from config)"
export GH_CONFIG_DIR="$scratch/gh2"
mkdir -p "$GH_CONFIG_DIR" "$scratch/auth"
seed_hosts "$scratch/auth/hosts.yml" alice
ln -s "$scratch/auth/hosts.yml" "$GH_CONFIG_DIR/hosts.yml"
echo "read through symlink: $(which_token)"
gh auth switch --hostname github.com --user bob >/dev/null 2>&1
gh config set editor vi
echo "after switch + config set:"
listing "$GH_CONFIG_DIR"
echo "symlink still a symlink? $([ -L "$GH_CONFIG_DIR/hosts.yml" ] && echo yes || echo no)"
echo "target now active: $(grep -E '^    user:' "$scratch/auth/hosts.yml" | awk '{print $2}')"
echo "config.yml written beside the symlink, not in the auth dir: $([ -f "$GH_CONFIG_DIR/config.yml" ] && echo yes) / auth dir: $(ls "$scratch/auth")"

say "5. A dangling symlink (shared volume empty): what gh does"
export GH_CONFIG_DIR="$scratch/gh3"
mkdir -p "$GH_CONFIG_DIR" "$scratch/auth3"
ln -s "$scratch/auth3/hosts.yml" "$GH_CONFIG_DIR/hosts.yml"
echo "gh auth token on empty: $(which_token)"
gh config set -h github.com git_protocol https
echo "after a host write: link=$([ -L "$GH_CONFIG_DIR/hosts.yml" ] && echo yes || echo no), target created=$([ -f "$scratch/auth3/hosts.yml" ] && echo yes || echo no) mode=$(stat -c %a "$scratch/auth3/hosts.yml" 2>/dev/null)"

say "6. Concurrent writers and a reader on one hosts.yml (in-place truncate window)"
export GH_CONFIG_DIR="$scratch/gh4"
mkdir -p "$GH_CONFIG_DIR"
seed_hosts "$GH_CONFIG_DIR/hosts.yml" alice
writer() { local _; for _ in $(seq 1 150); do gh config set -h github.com git_protocol "$1" 2>/dev/null; done; }
writer https & w1=$!
writer ssh & w2=$!
reads=0; bad=0; badkinds=""
while kill -0 "$w1" 2>/dev/null || kill -0 "$w2" 2>/dev/null; do
  r=$(which_token); reads=$((reads + 1))
  if [ "$r" != alice ]; then bad=$((bad + 1)); badkinds="$badkinds|$r"; fi
done
wait
echo "reads=$reads not-alice=$bad"
[ -z "$badkinds" ] || echo "$badkinds" | tr '|' '\n' | sed '/^$/d' | sort | uniq -c
echo "file still valid after the race: $(which_token), users kept: $(grep -cE '^        (alice|bob):' "$GH_CONFIG_DIR/hosts.yml")"

say "6b. The same race seen by a fast reader (plain file reads, no gh start-up cost)"
writer https & w1=$!
reads=0; torn=0
while kill -0 "$w1" 2>/dev/null; do
  c=$(cat "$GH_CONFIG_DIR/hosts.yml"); reads=$((reads + 1))
  case "$c" in *"user: alice"*) ;; *) torn=$((torn + 1)) ;; esac
done
wait
echo "reads=$reads saw an empty or partial hosts.yml: $torn"

say "7. Two concurrent logical updates (lost update): switch vs config set"
export GH_CONFIG_DIR="$scratch/gh5"
mkdir -p "$GH_CONFIG_DIR"
lost=0
for _ in $(seq 1 40); do
  seed_hosts "$GH_CONFIG_DIR/hosts.yml" alice
  gh auth switch --hostname github.com --user bob >/dev/null 2>&1 &
  gh config set -h github.com git_protocol ssh &
  wait
  u=$(grep -E '^    user:' "$GH_CONFIG_DIR/hosts.yml" | awk '{print $2}')
  p=$(grep -E '^    git_protocol:' "$GH_CONFIG_DIR/hosts.yml" | awk '{print $2}')
  [ "$u" = bob ] && [ "$p" = ssh ] || lost=$((lost + 1))
done
echo "rounds=40 where one of the two updates was lost: $lost"
