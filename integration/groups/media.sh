# media: LFS candidate sets and selection, bind to a dependent item, source
# assets (repository LFS file, private local file, GitHub attachment) and
# image review evidence.
media_needs() { echo "drill repo + Project with Git LFS and scripts/review-image.mjs + docs/parse.md fixtures on main; reviewArtifacts (set in the scratch config); a GitHub attachment URL (MEDIA_ATTACHMENT_URL)"; }
media_cost() { echo "~45-90 min; 5 Objectives in parallel to completion; source-input reviews are auto-accepted"; }
media_minutes() { echo 60; }
MEDIA_ATTACHMENT_URL=${MEDIA_ATTACHMENT_URL:-https://github.com/user-attachments/assets/e7d69315-2274-4873-a343-7c087c9f8543}
media_plan() {
  echo "media.select-bind      bind.md: select hold with candidate sets; answer one with 'bind <dependent item>'; merged starIcon sha256 = selected PNG's LFS oid"
  echo "media.lfs-candidates   cube.md: two candidate sets, operator picks one; assets land as LFS pointers"
  echo "media.sources          sources.md: repository LFS file + private local file; merged table holds both exact sha256s"
  echo "media.attachment       attachment.md: GitHub attachment fetched as an input; merged note holds its sha256"
  echo "media.image-review     palette.md: a done step's evidence carries a kind=image artifact"
  echo "media.capture-no-note  palette.md with FACTORY_NOTE_MS=60000: its capture continuations (retry with progress) post no waiting:note $(pre continuation note)"
}
media_cfg() {
  cfg_patch "$CUR_CFG" 'c["queue"]["maxActiveObjectives"]=5' "c.setdefault('media',{})['localAssetRoots']=['$SUITE/fixtures']" \
    'c["reviewArtifacts"]=[{"command":"node scripts/review-image.mjs","receipt":{"stdoutPathField":"receipt","stdoutSha256Field":"sha256","maxBytes":4096},"image":{"file":"swatch.png","sha256Field":"image","maxBytes":1048576},"candidate":{"file":"src/palette.js","sha256Field":"candidate"}}]'
}
# Answer a select hold: prefer the answer naming $2 (e.g. gold), with --text $3.
media_select() {
  local n=$1 prefer=$2 text=$3 hold pick
  hold=$(st hold "$n" 'item:*:select')
  pick=$(python3 -c 'import json,sys;h=json.loads(sys.argv[1]);a=[x for x in h["answers"] if x not in ("cancel","retry","replan")];p=[x for x in a if sys.argv[2] and sys.argv[2] in x];print((p or a or [""])[0])' "$hold" "$prefer")
  [ -n "$pick" ] || return 1
  local q; q=$(hold_field "$hold" id)
  if [ -n "$text" ]; then answer_t 60 "$n" "$pick" --question "$q" --text "$text" >/dev/null 2>&1; else answer_t 60 "$n" "$pick" --question "$q" >/dev/null 2>&1; fi
  echo "#$n selected $pick${text:+ ($text)}" >>"$RUN_DIR/notes.$n"; log "#$n selected $pick"
}
sha_of_pointer() { sed -n 's/^oid sha256:\([0-9a-f]\{64\}\)$/\1/p'; }

media_run() {
  # A planner question takes its recommended answer.
  local g=media t0 ids=() n HOLD_POLICY="$HOLD_POLICY decide"
  t0=$(now)
  local ib il is ia ii
  ib=$(uid); il=$(uid); is=$(uid); ia=$(uid); ii=$(uid)
  local cs; cs=$(python3 -c 'import random;print(" ".join("#%06x"%random.randrange(0x1000000) for _ in range(3)))')
  set -- $cs
  local nb="" nl="" ns="" na="" ni=""
  # MEDIA_ONLY (bind cube sources attachment palette) runs a subset.
  m_on() { [ -z "${MEDIA_ONLY:-}" ] || [[ " $MEDIA_ONLY " == *" $1 "* ]]; }
  m_on bind && nb=$(new_objective $g bind "media select-bind" ID="$ib")
  m_on cube && nl=$(new_objective $g cube "media lfs-candidates" ID="$il")
  m_on sources && ns=$(new_objective $g sources "media sources" ID="$is")
  m_on attachment && na=$(new_objective $g attachment "media attachment" ID="$ia" ATTACHMENT_URL="$MEDIA_ATTACHMENT_URL")
  m_on palette && ni=$(new_objective $g palette "media image-review" ID="$ii" C1="$1" C2="$2" C3="$3")
  # A short note delay: a continuation counted as a wait would post a note.
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV"
  has_feature continuation && has_feature note && SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_NOTE_MS=60000"
  serve_start || return
  local end=$(( $(now) + ${MEDIA_TIMEOUT:-7200} )) left p dep
  declare -A stuck=()
  while [ "$(now)" -lt "$end" ]; do
    serve_tick; left=0
    for n in $nb $nl $ns $na $ni; do
      p=$(st phase "$n")
      case $p in
        done|cancelled|failed) continue ;;
        hold:item:*:select)
          if [ ! -f "$RUN_DIR/selected.$n" ]; then
            touch "$RUN_DIR/selected.$n"
            if [ "$n" = "$nb" ]; then
              dep=$(st get "$n" done.plan.items | python3 -c 'import json,sys;sel=sys.argv[1];it=json.load(sys.stdin) or [];print(next((i["id"] for i in it if i["id"]!=sel), ""))' "$(echo "${p#hold:item:}" | sed 's/:select$//')")
              media_select "$n" gold "bind $dep"
            else media_select "$n" "" ""; fi
          else stuck[$n]=$p; continue; fi ;;
        hold:*) auto_answer "$n" || { stuck[$n]=$p; continue; } ;;
      esac
      left=$((left + 1))
    done
    [ $left -eq 0 ] && break
    sleep 10
  done
  sleep 20; serve_stop
  local ok f
  # select-bind
  t0=$(now)
  if m_on bind; then end_done "$nb"; ok=$?
  f=$(gh_file "src/starIcon$ib.js" | grep -oE '[0-9a-f]{64}' | head -1); local oid; oid=$(gh_file "assets/star$ib.png" | sha_of_pointer)
  if [ $ok = 0 ] && [ -n "$f" ] && [ "$f" = "$oid" ]; then record media.select-bind $g PASS "starIcon sha256 = LFS oid ${oid:0:12}; $EVID" "$t0"
  else record media.select-bind $g FAIL "starIcon sha256=${f:0:12} LFS oid=${oid:0:12} ${stuck[$nb]:+held ${stuck[$nb]}}; $EVID" "$t0"; fi
  fi
  # lfs-candidates
  if m_on cube; then end_done "$nl"; ok=$?
  local glb; glb=$(gh_file "assets/cube$il.glb" | head -1)
  if [ $ok = 0 ] && [[ $glb == "version https://git-lfs"* ]]; then record media.lfs-candidates $g PASS "cube$il.glb is an LFS pointer; $EVID" "$t0"
  else record media.lfs-candidates $g FAIL "glb head='${glb:0:30}' ${stuck[$nl]:+held ${stuck[$nl]}}; $EVID" "$t0"; fi
  fi
  # sources
  if m_on sources; then end_done "$ns"; ok=$?
  local doc priv red; doc=$(gh_file "docs/inputs$is.md"); priv=$(sha256sum "$SUITE/fixtures/private-brief.txt" | cut -d' ' -f1); red=$(gh_file assets/red.png | sha_of_pointer)
  if [ $ok = 0 ] && grep -q "$priv" <<<"$doc" && [ -n "$red" ] && grep -q "$red" <<<"$doc"; then record media.sources $g PASS "both sha256s in docs/inputs$is.md; $EVID" "$t0"
  else record media.sources $g FAIL "private=$(grep -c "$priv" <<<"$doc") red=$( [ -n "$red" ] && grep -c "$red" <<<"$doc") ${stuck[$ns]:+held ${stuck[$ns]}}; $EVID" "$t0"; fi
  # Source inputs pass result and final review with no operator accept.
  {
    local acc; acc=$(grep -c "auto-answered accept" "$RUN_DIR/notes.$ns" 2>/dev/null); acc=${acc:-0}
    local rh; rh=$(st events "$ns" event=outcome outcome=hold 'step=*review')
    [ "$(st status "$ns")" = done ] && [ "$acc" = 0 ] && [ "$rh" = 0 ] && record media.sources-no-accept $g PASS "#$ns done; review holds 0, accepts 0" "$t0" \
      || record media.sources-no-accept $g FAIL "#$ns status=$(st status "$ns"); review holds $rh, accepts $acc" "$t0"
  }
  fi
  # attachment
  if m_on attachment; then end_done "$na"; ok=$?
  if [ $ok = 0 ] && gh_file "docs/attachment$ia.md" | grep -qE '[0-9a-f]{64}'; then record media.attachment $g PASS "$EVID" "$t0"
  else record media.attachment $g FAIL "${stuck[$na]:+held ${stuck[$na]}}; $EVID" "$t0"; fi
  fi
  # image review
  m_on palette || return 0
  end_done "$ni"; ok=$?
  if [ $ok = 0 ] && [ "$(st artifacts-kind "$ni" image)" = 1 ]; then record media.image-review $g PASS "kind=image artifact in done evidence; $EVID" "$t0"
  else record media.image-review $g FAIL "image artifact=$(st artifacts-kind "$ni" image) ${stuck[$ni]:+held ${stuck[$ni]}}; $EVID" "$t0"; fi
  # a capture continuation posts no status note.
  t0=$(now)
  if need media.capture-no-note $g "$t0" continuation note; then
    local rt nt; rt=$(st events "$ni" event=outcome outcome=retry); nt=$(marker_count "$(gh_markers "$ni")" waiting:note)
    if [ "$rt" = 0 ]; then record media.capture-no-note $g UNREACHABLE "#$ni had no continuation (no retry outcome)" "$t0"
    elif [ "$nt" = 0 ]; then record media.capture-no-note $g PASS "#$ni continued $rt times with FACTORY_NOTE_MS=60000; waiting:note x0" "$t0"
    else record media.capture-no-note $g FAIL "#$ni retries $rt; waiting:note x$nt" "$t0"; fi
  fi
}
