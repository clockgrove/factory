/** Linux-only observer fault helper. Never used by Factory runtime or by read-only preflight. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// Primary contracts: https://docs.python.org/3/library/os.html#os.pidfd_open
// https://docs.python.org/3/library/signal.html#signal.pidfd_send_signal
// https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html
// Open a pidfd BEFORE checking birth/ownership; all signals use that stable descriptor.
const program = String.raw`
import os, sys, json, signal, select, time, stat, hashlib, subprocess
spec=json.loads(sys.argv[1]); role=sys.argv[2]; fd=None; armed=False
def emit(state):
    try:
        birth=read('/proc/self/stat',16384).decode().rsplit(')',1)[1].split()[19]
        print(json.dumps({'state':state,'role':role,'helperPid':os.getpid(),'helperStartTicks':birth}),flush=True)
    except BrokenPipeError: pass
def read(path, limit):
    with open(path,'rb') as file:
        value=file.read(limit+1)
    assert len(value)<=limit
    return value
def exited():
    poll=select.poll(); poll.register(fd,select.POLLIN)
    return bool(poll.poll(0))
def process_state():
    fields=read('/proc/'+str(spec['pid'])+'/stat',16384).decode().rsplit(')',1)[1].split()
    assert fields[19]==spec['startTicks']
    return fields[0]
def observe_state(stopped):
    for _ in range(50):
        if exited(): return False
        if (process_state() in ['T','t'])==stopped: return True
        time.sleep(.02)
    raise RuntimeError('requested process state not observed')
def verify():
    pid=spec['pid']; root='/proc/'+str(pid)
    assert os.getuid()==spec['uid'] and os.stat(root).st_uid==spec['uid']
    fields=read(root+'/stat',16384).decode().rsplit(')',1)[1].split()
    assert fields[19]==spec['startTicks']
    assert os.readlink(root+'/exe')==spec['node'] and os.readlink(root+'/cwd')==spec['checkout']
    assert read(root+'/cmdline',65536).decode().split('\0')[:-1]==spec['argv']
    assert ('0::'+spec['cgroup']) in read(root+'/cgroup',16384).decode().splitlines()
    assert stat.S_ISREG(os.lstat(spec['configPath']).st_mode)
    assert hashlib.sha256(read(spec['configPath'],16384)).hexdigest()==spec['configDigest']
    output=subprocess.run(['/usr/bin/systemctl','--user','show',spec['unit'],
      '--property=MainPID,InvocationID,ControlGroup'],check=True,stdout=subprocess.PIPE,
      stderr=subprocess.DEVNULL,timeout=10).stdout
    assert len(output)<=16384
    values=dict(line.split('=',1) for line in output.decode().splitlines())
    assert values['MainPID']==str(pid) and values['InvocationID']==spec['invocationId'] and values['ControlGroup']==spec['cgroup']
def interrupted(signum, frame): raise SystemExit(2)
signal.signal(signal.SIGTERM,interrupted); signal.signal(signal.SIGINT,interrupted)
try:
    assert role in ['primary','watchdog'] and 1000<=spec['maximumMs']<=750000
    fd=os.pidfd_open(spec['pid'],0)
    verify()
    assert process_state() not in ['T','t'] # never adopt an independently stopped process
    signal.pidfd_send_signal(fd,0,None,0) # permissions/liveness check; no signal is delivered
    armed=True
    if role=='primary':
        signal.pidfd_send_signal(fd,signal.SIGSTOP,None,0)
        assert observe_state(True)
    emit('frozen' if role=='primary' else 'armed')
    ready=select.select([sys.stdin],[],[],spec['maximumMs']/1000)[0]
    command=os.read(sys.stdin.fileno(),32) if ready else b''
    if command==b'disarm\n':
        assert role=='watchdog'
        armed=False
        emit('disarmed')
finally:
    signal.signal(signal.SIGTERM,signal.SIG_IGN); signal.signal(signal.SIGINT,signal.SIG_IGN)
    if armed:
        try:
            verify()
            signal.pidfd_send_signal(fd,signal.SIGCONT,None,0)
            emit('continued-exact-incarnation' if observe_state(False) else 'original-process-absent')
        except BaseException:
            # Missing config/proc metadata is not process-absence evidence. Only the
            # original pidfd's exit readiness can establish that incarnation ended.
            emit('original-process-absent' if exited() else 'thaw-unverified')
    if fd is not None: os.close(fd)
`;

const helperEnvironment = () => ({
  PATH: "/usr/bin:/bin",
  HOME: homedir(),
  LANG: "C.UTF-8",
  XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus`,
});

/** Read-only capability inspection: opens/closes a self pidfd, never delivers any signal. */
export function inspectFreezeCapability() {
  const source =
    "import os,signal,sys,json; fd=os.pidfd_open(os.getpid(),0); assert callable(signal.pidfd_send_signal); os.close(fd); print(json.dumps({'python':list(sys.version_info[:3]),'pidfdOpen':True,'pidfdSendSignalPresent':True,'signalsDelivered':False}))";
  return JSON.parse(
    execFileSync("/usr/bin/python3", ["-I", "-c", source], {
      env: helperEnvironment(),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 4096,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

/** Refuse before freeze unless actual server observations leave time for the bounded public call. */
export function assertInnerContentionWindow({ outer, inner, serverTime, remainingMs }) {
  const now = Date.parse(serverTime),
    outerExpiry = Date.parse(outer.expiresAt),
    innerExpiry = Date.parse(inner.expiresAt);
  assert.ok([now, outerExpiry, innerExpiry].every(Number.isFinite));
  assert.ok(["RepositoryLeaseAcquired", "RepositoryLeaseRenewed"].includes(outer.event));
  assert.ok(["LeaseAcquired", "LeaseRenewed"].includes(inner.event));
  const untilOuter = outerExpiry - now;
  assert.ok(
    untilOuter >= 30000 && untilOuter <= 600000,
    "outer lease lacks bounded preparation time",
  );
  assert.ok(
    innerExpiry - outerExpiry >= 180000,
    "observed expiry separation cannot safely reach inner lock",
  );
  assert.ok(innerExpiry - outerExpiry <= 300000, "inner expiry exceeds bounded follow-up wait");
  const maximumMs = untilOuter + 150000;
  assert.ok(
    maximumMs <= 750000 && remainingMs > innerExpiry - now + 300000,
    "unchanged scenario deadline cannot cover lease fault and completion",
  );
  return {
    outerExpiry,
    innerExpiry,
    maximumMs,
    serverTime,
    separationMs: innerExpiry - outerExpiry,
  };
}

export function assertHeldInnerRefusal({
  response,
  objective,
  inner,
  afterInner,
  outer,
  acquired,
  released,
}) {
  assert.deepEqual(
    response,
    {
      isError: true,
      content: [
        { type: "text", text: `Objective #${objective} is leased by ${inner.event.holder}` },
      ],
    },
    "public contender did not reach the still-held inner Director lease",
  );
  assert.equal(inner.event.kind, "lease");
  assert.equal(inner.event.objective, objective);
  assert.equal(afterInner.oid, inner.oid, "losing contender changed the inner lease");
  assert.deepEqual(afterInner.event, inner.event);
  assert.equal(released.record.event, "RepositoryLeaseReleased");
  assert.equal(acquired.record.event, "RepositoryLeaseAcquired");
  assert.equal(acquired.record.epoch, outer.record.epoch + 1);
  assert.notEqual(acquired.record.controllerId, outer.record.controllerId);
  assert.equal(acquired.record.previousOid, outer.oid);
  assert.deepEqual(acquired.parents, [outer.oid]);
  assert.equal(released.record.previousOid, acquired.oid);
  assert.deepEqual(released.parents, [acquired.oid]);
  for (const key of ["controllerId", "epoch", "policyDigest"])
    assert.equal(acquired.record[key], released.record[key]);
}

function startHelper(spec, role) {
  const child = spawn("/usr/bin/python3", ["-I", "-u", "-c", program, JSON.stringify(spec), role], {
    env: helperEnvironment(),
    stdio: ["pipe", "pipe", "ignore"],
    detached: true,
  });
  child.stdin.on("error", () => {}); // EPIPE is reconciled by the bounded close/receipt proof below.
  const records = [];
  let output = "";
  let acknowledge, rejectReady;
  const ready = new Promise((resolve, reject) => {
    acknowledge = resolve;
    rejectReady = reject;
  });
  const timeout = setTimeout(() => {
    child.stdin.end();
    rejectReady(Error("freeze helper readiness unavailable; exact thaw must be observed"));
  }, 15000);
  child.stdout.on("data", (data) => {
    output += data.toString();
    if (output.length > 8192) {
      child.stdin.end();
      rejectReady(Error("freeze helper output exceeds bound"));
      return;
    }
    while (output.includes("\n")) {
      const end = output.indexOf("\n"),
        line = output.slice(0, end);
      output = output.slice(end + 1);
      try {
        const record = JSON.parse(line);
        assert.equal(record.role, role);
        assert.equal(record.helperPid, child.pid);
        assert.ok(
          [
            "frozen",
            "armed",
            "disarmed",
            "continued-exact-incarnation",
            "original-process-absent",
            "thaw-unverified",
          ].includes(record.state),
        );
        records.push(record);
        if (record.state === (role === "primary" ? "frozen" : "armed")) {
          clearTimeout(timeout);
          acknowledge(record);
        }
      } catch {
        child.stdin.end();
        rejectReady(Error("freeze helper response invalid"));
      }
    }
  });
  child.on("error", () => {
    clearTimeout(timeout);
    rejectReady(Error("freeze helper unavailable"));
  });
  let closed = false;
  const ended = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      rejectReady(Error("freeze helper ended before readiness"));
      resolve({ code, signal, records, closed: true });
    }),
  );
  return {
    ready,
    ended,
    records,
    get closed() {
      return closed;
    },
    release: (command = "continue\n") => {
      if (!child.stdin.destroyed) child.stdin.end(command);
    },
  };
}

async function boundedEnd(helper) {
  let timer;
  try {
    return await Promise.race([
      helper.ended,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ closed: false, records: helper.records }), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Two independent pidfd holders: ordinary parent/one-helper loss still permits bounded exact thaw.
 * Killing both helpers bypasses finally/watchdogs. Retained evidence must then be treated as
 * potentially frozen; revalidate its PID/startTicks/unit/invocation before any operator SIGCONT.
 */
export async function withFrozenController(spec, operation, record, start = startHelper) {
  assert.ok(spec.pid > 1 && spec.uid > 0 && spec.pid !== process.pid);
  assert.match(spec.startTicks, /^[0-9]+$/);
  assert.match(spec.invocationId, /^[a-f0-9]{32}$/);
  assert.equal(spec.configPath, join(homedir(), ".config/systemd/user", spec.unit));
  record({
    state: "requested",
    spec,
    cleanupGuarantee: "two-independent-pidfds; both-helper-SIGKILL-not-covered",
  });
  const watchdog = start(spec, "watchdog");
  let primary;
  try {
    await watchdog.ready;
    primary = start(spec, "primary");
    await primary.ready;
    record({ state: "frozen", helpers: [...watchdog.records, ...primary.records] });
    return await operation(() => {
      assert.ok(
        !primary.closed &&
          !watchdog.closed &&
          ![...primary.records, ...watchdog.records].some((entry) =>
            ["continued-exact-incarnation", "original-process-absent", "thaw-unverified"].includes(
              entry.state,
            ),
          ),
        "freeze ownership ended before the intended boundary",
      );
    });
  } finally {
    primary?.release();
    // EOF also triggers cleanup on observer failure. The watchdog is disarmed only after
    // explicit successful primary thaw; its own timeout/EOF otherwise retains that duty.
    const result = primary ? await boundedEnd(primary) : null;
    const thawed = result?.records.some((entry) =>
      ["continued-exact-incarnation", "original-process-absent"].includes(entry.state),
    );
    watchdog.release(thawed ? "disarm\n" : "continue\n");
    const backup = await boundedEnd(watchdog);
    const verified =
      thawed ||
      backup.records.some((entry) =>
        ["continued-exact-incarnation", "original-process-absent"].includes(entry.state),
      );
    record({
      state: !primary
        ? "freeze-not-started"
        : verified
          ? "thaw-observed"
          : "potentially-frozen-manual-reconciliation-required",
      primary: result,
      watchdog: backup,
      spec,
    });
    assert.ok(
      !primary || verified,
      "exact controller thaw unverified; do not retry, inspect retained incarnation evidence",
    );
    assert.ok(
      (!primary || result.closed) && backup.closed,
      "observer helper termination unverified; retain exact helper incarnation for cleanup",
    );
  }
}
