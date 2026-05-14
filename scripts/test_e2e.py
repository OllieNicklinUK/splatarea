#!/usr/bin/env python3
"""
End-to-end test for viverse-ai-agent.
Sends a flow-line-v1 build request, submits credentials, monitors to completion.
Usage: python3 scripts/test_e2e.py [--template flow-line-v1] [--timeout 900]
"""
import sys, os, json, time, re, subprocess, argparse
from datetime import datetime, timezone

WS_DIR  = os.path.expanduser('~/Projects/AI/viverse-ai-agent/.viverse_workspaces')
SERVER  = 'http://localhost:3000'
EMAIL   = 'caspertest@yopmail.com'
PASSWORD = 'Aa0110test'

PROMPTS = {
    'flow-line-v1': (
        'Create a new puzzle game using template flow-line-v1. '
        'Keep the VIVERSE auth, profile chip, leaderboard wiring, and PlayCanvas runtime intact. '
        'Customize visuals into a neon circuit theme.'
    ),
    'blank-webapp-v1': (
        'Create a new utility app using template blank-webapp-v1. '
        'Build a simple countdown timer with a clean dark UI.'
    ),
}

def ts(): return f"[{datetime.now().strftime('%H:%M:%S')}]"
def log(m, c=''): print(f"{ts()} {c}{m}", flush=True)

def latest_workspace_for_template(template_id, min_age_s=0):
    """Return newest req_id for given template that is running/awaiting."""
    now_ms = time.time() * 1000
    for d in sorted(os.listdir(WS_DIR), reverse=True):
        if not d.startswith('req_'): continue
        ts_ms = int(d.replace('req_', ''))
        if (now_ms - ts_ms) / 1000 < min_age_s: continue
        try:
            s = json.load(open(f'{WS_DIR}/{d}/.agent_state.json'))
            tmpl = s.get('templateContext', {}).get('templateId', '')
            if template_id in tmpl and s.get('status') in ('running', 'awaiting_credentials'):
                return d, s
        except: pass
    return None, None

def stream_post(payload, timeout_s=30):
    """POST to /api/ai/chat and collect lines until DONE or timeout."""
    import urllib.request
    data = json.dumps(payload).encode()
    req  = urllib.request.Request(
        f'{SERVER}/api/ai/chat',
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    lines = []
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            deadline = time.time() + timeout_s
            while time.time() < deadline:
                raw = resp.readline()
                if not raw: break
                line = raw.decode('utf-8', 'replace').strip()
                if line: lines.append(line)
                if line == 'data: [DONE]': break
                # Return early once we have workspace path
                if any(k in line for k in ['require_credentials', 'sandboxed workspace', 'reqId']):
                    break
    except Exception as e:
        lines.append(f'ERROR: {e}')
    return lines

def wait_for_completion(req_id, timeout_s=900):
    """Poll state file until completed/paused_or_failed or timeout."""
    state_file = f'{WS_DIR}/{req_id}/.agent_state.json'
    deadline = time.time() + timeout_s
    last_tasks = {}
    last_status = None
    t_start_wall = time.time()

    log(f"Monitoring {req_id} (timeout={timeout_s}s)...")

    while time.time() < deadline:
        try:
            d = json.load(open(state_file))
            status = d.get('status', '?')
            tasks  = {t['id']: (t['status'], t['role']) for t in d.get('tasks', [])}

            if status != last_status:
                log(f"STATUS → {status}  stage={d.get('currentStage','?')}")
                last_status = status

            for tid, (tstat, role) in tasks.items():
                if last_tasks.get(tid) != tstat and tstat != 'pending':
                    evs = d.get('runReport', {}).get('events', [])
                    dur = next((e.get('durationMs',0) for e in evs
                        if e.get('taskId')==tid and 'started' not in e.get('type','')), 0)
                    icon = {'completed':'✅','failed':'❌','blocked':'🚫'}.get(tstat,'⏳')
                    reason = next((str(e.get('reason',''))[:70] for e in evs
                        if e.get('taskId')==tid and e.get('type','') in ('task_failed','task_blocked')), '')
                    log(f"{icon} {tid:40} {role:10} → {tstat}{f' ({dur//1000}s)' if dur else ''}{f'  ← {reason}' if reason else ''}")
                    last_tasks[tid] = tstat

            if status in ('completed', 'paused_or_failed'):
                wall = int(time.time() - t_start_wall)
                return d, wall

        except: pass
        time.sleep(6)

    return None, int(time.time() - t_start_wall)

def summarize(state, wall_s):
    """Print final summary with pass/fail."""
    if not state:
        log("TIMEOUT — no final state", "❌ ")
        return False

    status   = state.get('status')
    final    = state.get('finalOutcome', {})
    vl       = state.get('verificationLedger', [])
    evs      = state.get('runReport', {}).get('events', [])

    # Task timing table
    t0 = None
    print()
    print("─"*70)
    print(f"  {'Task':40} {'Dur':>6}  {'Status'}")
    print("─"*70)
    task_total = 0
    for e in evs:
        try:
            t = datetime.fromisoformat(e['at'].replace('Z','+00:00'))
            if not t0: t0 = t
        except: continue
        et = e.get('type',''); tid = e.get('taskId',''); dur = e.get('durationMs',0)
        if 'completed' in et or 'failed' in et:
            task_total += dur
            icon = '✅' if 'completed' in et else '❌'
            print(f"  {icon} {tid:40} {dur//1000:>5}s  {et.split('_')[1]}")
    print("─"*70)
    print(f"  {'Tasks total':40} {task_total//1000:>5}s")
    print(f"  {'Wall time':40} {wall_s:>5}s")
    print()

    # Verifier result
    verifier_pass = any(e.get('type')=='verifier' and e.get('status')=='pass' for e in vl)
    src_hash = next((e.get('sourceHash','') for e in vl
        if e.get('type')=='verifier' and e.get('status')=='pass' and e.get('sourceHash')),'')

    print(f"  status:      {status}")
    print(f"  appId:       {final.get('appId', state.get('runtimeFlags',{}).get('appIdAuthority',{}).get('value','—'))}")
    print(f"  previewUrl:  {final.get('previewUrl','—')}")
    print(f"  verifier:    {'PASS ✅' if verifier_pass else 'FAIL ❌'}")
    print(f"  sourceHash:  {src_hash[:12] or '—'}")
    print()

    # Failure detail
    if status != 'completed':
        halt = next((l for l in state.get('projectContextSummary','').split('\n')
            if 'HALTED' in l or 'FAILED' in l), '')
        if halt: print(f"  halt reason: {halt[:120]}")
    print("─"*70)

    passed = status == 'completed' and verifier_pass
    print(f"\n  RESULT: {'PASS ✅' if passed else 'FAIL ❌'}")
    return passed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--template', default='flow-line-v1')
    parser.add_argument('--timeout', type=int, default=900)
    args = parser.parse_args()

    template_id = args.template
    prompt = PROMPTS.get(template_id, PROMPTS['flow-line-v1'])

    log(f"=== E2E TEST: {template_id} ===")
    log(f"Prompt: {prompt[:80]}...")

    # ── Step 1: Send initial request ─────────────────────────────────────────
    log("Step 1: Sending initial request...")
    t_req_start = time.time()
    lines = stream_post({'message': prompt, 'templateId': template_id, 'rulesetId': 'default'})

    needs_creds = any('require_credentials' in l for l in lines)
    log(f"  stream lines received: {len(lines)}, needs_creds={needs_creds}")

    # Wait briefly for workspace to be written, then find it
    time.sleep(4)
    req_id, state = latest_workspace_for_template(template_id, min_age_s=0)
    # Also check state file for awaiting_credentials
    if state and state.get('status') == 'awaiting_credentials':
        needs_creds = True
    if not req_id:
        log("ERROR: no workspace created", "❌ ")
        sys.exit(1)
    log(f"  workspace: {req_id}  status={state.get('status')}")

    # ── Step 2: Submit credentials if needed ─────────────────────────────────
    if needs_creds or state.get('status') == 'awaiting_credentials':
        log("Step 2: Submitting credentials...")
        cred_lines = stream_post({
            'message': prompt,
            'credentials': {'email': EMAIL, 'password': PASSWORD}
        }, timeout_s=30)
        log(f"  cred stream lines: {len(cred_lines)}")
        time.sleep(6)
        # The credential request creates a fresh workspace; find the newest running one
        req_id2, state2 = latest_workspace_for_template(template_id, min_age_s=0)
        if req_id2 and state2 and state2.get('status') == 'running':
            req_id, state = req_id2, state2
            log(f"  active workspace: {req_id}")
        else:
            try:
                state = json.load(open(f'{WS_DIR}/{req_id}/.agent_state.json'))
                log(f"  workspace status after creds: {state.get('status')}")
            except: pass
        # If still awaiting, the server picked up an old stale workspace
        # Fall through to monitor — it may self-resolve
        if state and state.get('status') == 'awaiting_credentials':
            log('⚠️  Still awaiting_credentials — server may have a stale workspace. Monitoring anyway...')
    else:
        log("Step 2: Credentials included in initial request — skipping")

    # ── Step 3: Monitor to completion ────────────────────────────────────────
    log(f"Step 3: Monitoring {req_id}...")
    final_state, wall_s = wait_for_completion(req_id, timeout_s=args.timeout)

    # ── Step 4: Summarize ────────────────────────────────────────────────────
    passed = summarize(final_state, wall_s)
    sys.exit(0 if passed else 1)


if __name__ == '__main__':
    main()
