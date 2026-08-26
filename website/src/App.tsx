import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

const GITHUB = 'https://github.com/Gdm0714/gdm';
const INSTALL = 'curl -fsSL https://raw.githubusercontent.com/Gdm0714/gdm/main/install.sh | bash';

type CheckState = 'pending' | 'open' | 'running' | 'proven';
type MobileTab = 'tasks' | 'agents' | 'proof';

type WorkbenchStage = {
  tag: string;
  title: string;
  detail: string;
  taskState: string;
  count: string;
};

const stages: WorkbenchStage[] = [
  {
    tag: 'WORKTREE',
    title: '작업을 먼저 격리합니다',
    detail: 'fix-login 전용 branch와 worktree가 생성됩니다. 프로젝트 본체는 건드리지 않습니다.',
    taskState: 'WORKTREE CREATED',
    count: '0/3',
  },
  {
    tag: 'PLAN',
    title: '완료 조건을 먼저 등록합니다',
    detail: 'PLAN NEEDED 상태에서 c1 regression, c2 behavior, c3 static 검증 항목을 등록합니다.',
    taskState: 'PLAN NEEDED',
    count: '0/3',
  },
  {
    tag: 'APPROVE',
    title: '사람이 계획을 승인합니다',
    detail: '사용자가 명령과 기대 결과를 확인해야 READY 0/3이 됩니다. 승인 전에는 실행하지 않습니다.',
    taskState: 'READY 0/3',
    count: '0/3',
  },
  {
    tag: 'RUN',
    title: '각 에이전트가 자기 lane에서 실행됩니다',
    detail: 'Codex가 PRIMARY로, Claude와 Gemini가 SECONDARY로 같은 작업 계약을 보고 실행합니다.',
    taskState: 'RUNNING 0/3',
    count: '0/3',
  },
  {
    tag: 'VERIFY',
    title: 'gdm이 첫 검증 명령을 직접 실행합니다',
    detail: 'c1이 OPEN에서 RUNNING으로 바뀝니다. 출력과 exit code는 로컬 evidence로 남습니다.',
    taskState: 'VERIFYING 0/3',
    count: '0/3',
  },
  {
    tag: 'VERIFY',
    title: '각 check가 재현 가능한 증거를 남깁니다',
    detail: 'c1과 c2가 PROVEN이 되고 c3를 실행합니다. 각 결과에는 명령·출력·SHA-256이 묶입니다.',
    taskState: 'VERIFYING 2/3',
    count: '2/3',
  },
  {
    tag: 'PROVE',
    title: '모든 증거가 모였을 때만 완료됩니다',
    detail: '3/3 PROVEN · 0 BLOCKERS. 실행 노드가 Orbit G에 도킹하고 Verified 상태로 전환됩니다.',
    taskState: 'VERIFIED',
    count: '3/3',
  },
];

const stageDurations = [1300, 1300, 1200, 1300, 1400, 1300, 1200];

const checks = [
  { id: 'c1', kind: 'regression', title: '로그인 회귀 테스트', command: 'bun test login', hash: '2f5e8c1b9d…' },
  { id: 'c2', kind: 'behavior', title: '기존 세션 유지', command: 'bun test session', hash: '9f3b21a6e0…' },
  { id: 'c3', kind: 'static', title: '범위 밖 변경 없음', command: 'gdm plan verify --scope cli/src cli/test', hash: '7aa44d0e9…' },
];

const flow = ['CONTRACT', 'PLAN', 'APPROVE', 'RUN', 'VERIFY', 'PROVE'];

type MotionPhase = 'idle' | 'running' | 'settled';

type MotionSectionProps = {
  children: ReactNode;
  className?: string;
  label: string;
  once?: boolean;
};

function MotionSection({ children, className = '', label, once = false }: MotionSectionProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<MotionPhase>('idle');
  const playedRef = useRef(false);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const settle = () => {
      if (query.matches) {
        playedRef.current = true;
        setPhase('settled');
      }
    };
    settle();
    query.addEventListener('change', settle);
    const observer = new IntersectionObserver(([entry]) => {
      if (query.matches) return;
      if (entry.isIntersecting) {
        if (!once || !playedRef.current) {
          playedRef.current = true;
          setPhase('running');
        } else {
          setPhase('settled');
        }
      } else {
        setPhase(playedRef.current ? 'settled' : 'idle');
      }
    }, { threshold: 0.28 });
    observer.observe(node);
    return () => {
      observer.disconnect();
      query.removeEventListener('change', settle);
    };
  }, [once]);

  return (
    <div ref={rootRef} className={`motion-section ${className}`.trim()} data-motion={phase} data-motion-label={label}>
      {children}
    </div>
  );
}

function tabForStage(stage: number): MobileTab {
  if (stage <= 2) return 'tasks';
  if (stage === 3) return 'agents';
  return 'proof';
}

function OrbitMark({ small = false }: { small?: boolean }) {
  return (
    <img
      className={small ? 'orbit-mark orbit-mark-small' : 'orbit-mark'}
      src="/assets/animated-static.svg"
      alt=""
      aria-hidden="true"
    />
  );
}

function stateForCheck(stage: number, index: number): CheckState {
  if (stage === 0) return 'pending';
  if (stage <= 3) return 'open';
  if (stage === 4) return index === 0 ? 'running' : 'open';
  if (stage === 5) return index < 2 ? 'proven' : 'running';
  return 'proven';
}

const checkGlyph: Record<CheckState, string> = {
  pending: '–',
  open: '○',
  running: '◌',
  proven: '✓',
};

const checkLabel: Record<CheckState, string> = {
  pending: 'PENDING PLAN',
  open: 'OPEN',
  running: 'RUNNING',
  proven: 'PROVEN',
};

function ProofChecks({ stage, compact = false }: { stage: number; compact?: boolean }) {
  return (
    <div className={compact ? 'proof-checks proof-checks-compact' : 'proof-checks'}>
      {checks.map((check, index) => {
        const status = stateForCheck(stage, index);
        return (
          <div className={`proof-check proof-check-${status}`} key={check.id}>
            <div className="proof-check-heading">
              <span className={`check-glyph check-glyph-${status}`} aria-hidden="true">
                {checkGlyph[status]}
              </span>
              <span className="status-tag">{checkLabel[status]}</span>
              <span>{check.id} · {check.kind}</span>
            </div>
            <strong>{check.title}</strong>
            <code>{check.command}</code>
            {!compact && <small>exit {status === 'proven' ? '0' : '—'} · sha {status === 'proven' ? check.hash : 'awaiting evidence'}</small>}
          </div>
        );
      })}
    </div>
  );
}

function HeroProofRail() {
  return (
    <aside className="hero-proof" aria-label="완료된 fix-login 작업의 Proof Rail 예시">
      <header className="panel-header">
        <span>PROOF RAIL · FIX-LOGIN</span>
        <span className="signal-proven">✓ 3 / 3 PROVEN</span>
      </header>
      <div className="hero-contract">
        <span className="data-label">CONTRACT</span>
        <strong>로그인 오류 수정</strong>
        <p>필수 · 기존 로그인 동작 보존</p>
        <p>금지 · 자동 커밋</p>
      </div>
      <div className="hero-proof-checks">
        {checks.map((check, index) => (
          <div className="hero-proof-check" style={{ '--motion-order': index } as CSSProperties} key={check.id}>
            <p><span className="status-tag status-tag-proven">✓ PROVEN</span> {check.id} · {check.kind}</p>
            <strong>{check.title}</strong>
            <code>{check.command} · exit 0 · sha {check.hash}</code>
          </div>
        ))}
      </div>
      <footer className="completion-gate">
        <span>COMPLETION GATE</span>
        <strong className="signal-proven">0 BLOCKERS</strong>
        <p><span className="signal-active">● gdm state</span> <span>3/3 proven</span> <b className="signal-proven">✓ Verified</b></p>
      </footer>
    </aside>
  );
}

function TaskRail({ stage }: { stage: number }) {
  const attention = stage === 1;
  const complete = stage === stages.length - 1;
  return (
    <aside className="task-rail" aria-label="작업 목록">
      <header className="panel-header"><span>TASKS · 3</span><span>＋</span></header>
      <div className="task-row task-row-active">
        <span className={`task-glyph ${complete ? 'signal-proven' : attention ? 'signal-attention' : 'signal-active'}`} aria-hidden="true">
          {complete ? '✓' : attention ? '◇' : '▶'}
        </span>
        <span><strong>fix-login</strong><small>{stages[stage].taskState}</small></span>
        <b>{stages[stage].count}</b>
      </div>
      <div className="task-row task-row-muted"><span>✓</span><span><strong>native-agent-loop</strong><small>PROVEN</small></span><b>4/4</b></div>
      <div className="task-row task-row-muted"><span>✓</span><span><strong>release-gate</strong><small>PROVEN</small></span><b>3/3</b></div>
      <div className="worktree-readout">
        <span className="data-label">WORKTREE</span>
        <code>~/gdm-worktrees/fix-login</code>
        <small>branch · gdm/fix-login</small>
      </div>
    </aside>
  );
}

function AgentLanes({ stage, mobile = false }: { stage: number; mobile?: boolean }) {
  const active = stage >= 3 && stage < 6;
  const done = stage === 6;
  return (
    <section className={mobile ? 'agent-lanes agent-lanes-mobile' : 'agent-lanes'} aria-label="에이전트 실행 lane">
      <div className="lane-tabs" role="presentation">
        <span className={active ? 'lane-tab lane-tab-active' : 'lane-tab'}>CODEX <b>PRIMARY</b></span>
        <span className="lane-tab">CLAUDE <b>SECONDARY</b></span>
        <span className="lane-tab">GEMINI <b>SECONDARY</b></span>
      </div>
      <div className="terminal-panes">
          <div className={`terminal-pane ${active ? 'terminal-pane-active' : ''}`}>
          <div className="terminal-title"><span>CODEX · interactive PTY</span><span className={done ? 'signal-proven' : active ? 'signal-active' : 'text-tertiary'}>{done ? '✓ handed off' : active ? '● running' : '○ standby'}</span></div>
          <div className="terminal-transcript" aria-label="고정된 터미널 transcript 예시">
            <p>$ bun test login</p>
            <p>bun test v1.1.30</p>
            <p>17 pass</p>
            <p className="signal-blocked">1 fail</p>
            <br />
            <p>FAIL refreshes an expired session and retries once</p>
            <p className="text-secondary">Expected request count: 2</p>
            <p className="text-secondary">Received request count: 3</p>
            <br />
            <p className="text-secondary">agent · 수정 범위: cli/src/session.ts, cli/test/session.test.ts</p>
            <p>$ <span className={active ? 'terminal-cursor terminal-cursor-active' : 'terminal-cursor'} aria-hidden="true" /></p>
          </div>
        </div>
        {!mobile && (
          <div className="terminal-pane terminal-pane-secondary">
            <div className="terminal-title"><span>CLAUDE / GEMINI</span><span className={active ? 'signal-active' : 'text-tertiary'}>{active ? '● linked' : '○ standby'}</span></div>
            <div className="terminal-transcript">
              <p>shared contract · fix-login</p>
              <p>worktree · ~/gdm-worktrees/fix-login</p>
              <br />
              <p>Claude · session boundary review</p>
              <p>Gemini · static scope review</p>
              <br />
              <p className="text-secondary">각 lane은 독립 PTY에서 실행됩니다.</p>
              <p className="text-secondary">Handoff는 현재 plan fingerprint에 묶입니다.</p>
            </div>
          </div>
        )}
      </div>
      {!mobile && (
        <div className="diff-evidence">
          <div><span className="data-label">DIFF</span><code><i>−</i> if (isExpired(token)) await refresh();<br /><b>+</b> if (isExpired(token)) {'{'} await refresh({'{'} countAsRequest: false {'}'}); {'}'}</code></div>
          <div><span className="data-label">EVIDENCE</span><code>cmd&nbsp;&nbsp;&nbsp;&nbsp; bun test login<br />expect&nbsp; exit 0<br />sha256&nbsp; 2f5e8c1b9d4a77e0…</code></div>
        </div>
      )}
    </section>
  );
}

function ProofRail({ stage, mobile = false }: { stage: number; mobile?: boolean }) {
  const complete = stage === stages.length - 1;
  const progress = stage < 4 ? 0 : stage === 4 ? 18 : stage === 5 ? 72 : 100;
  return (
    <aside className={mobile ? 'proof-rail proof-rail-mobile' : 'proof-rail'} aria-label="실시간 검증 상태">
      <header className="panel-header">
        <span>PROOF RAIL</span>
        <span className={complete ? 'signal-proven' : stage >= 4 ? 'signal-active' : 'signal-attention'}>{complete ? '✓ VERIFIED' : stage >= 4 ? '◌ VERIFYING' : '◇ OPEN'}</span>
      </header>
      <div className="proof-contract">
        <span className="data-label">CONTRACT</span>
        <strong>로그인 오류 수정</strong>
        <p>필수 · 기존 로그인 동작 보존</p>
        <p>금지 · 자동 커밋</p>
      </div>
      <ProofChecks stage={stage} compact={mobile} />
      <div className="proof-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
      <div className="proof-counter" aria-live="polite">
        <span>COMPLETION GATE</span>
        <strong key={stages[stage].count}>{stages[stage].count}</strong>
        <small className={complete ? 'signal-proven' : 'text-secondary'}>{complete ? 'PROVEN · 0 BLOCKERS' : stages[stage].taskState}</small>
      </div>
      <button className="done-button" type="button" disabled={!complete}>gdm done --slug fix-login</button>
    </aside>
  );
}

function MobileWorkbench({ stage, tab, onTabChange }: { stage: number; tab: MobileTab; onTabChange: (tab: MobileTab) => void }) {
  const tabs: { id: MobileTab; label: string }[] = [
    { id: 'tasks', label: 'Tasks' },
    { id: 'agents', label: 'Agents' },
    { id: 'proof', label: 'Proof' },
  ];

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    onTabChange(tabs[next].id);
    window.requestAnimationFrame(() => document.getElementById(`workbench-tab-${tabs[next].id}`)?.focus());
  };

  return (
    <div className="mobile-workbench">
      <div className="mobile-tabs" role="tablist" aria-label="Workbench 보기">
        {tabs.map((item, index) => (
          <button
            id={`workbench-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`workbench-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => onTabChange(item.id)}
            onKeyDown={(event) => handleTabKey(event, index)}
            key={item.id}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div id={`workbench-panel-${tab}`} role="tabpanel" aria-labelledby={`workbench-tab-${tab}`} className="mobile-tab-panel">
        {tab === 'tasks' && <TaskRail stage={stage} />}
        {tab === 'agents' && <AgentLanes stage={stage} mobile />}
        {tab === 'proof' && <ProofRail stage={stage} mobile />}
      </div>
    </div>
  );
}

function OrbitDock({ stage }: { stage: number }) {
  const complete = stage === stages.length - 1;
  return (
    <div className={`orbit-dock orbit-dock-stage-${stage}`} role="img" aria-label={complete ? '파란 실행 노드가 Orbit G에 도킹해 초록색 Verified 상태가 됨' : '파란 실행 노드가 Orbit G를 향해 이동 중'}>
      <span className="dock-track" aria-hidden="true" />
      <span className={`run-node ${complete ? 'run-node-proven' : ''}`} aria-hidden="true" />
      <OrbitMark small />
    </div>
  );
}

function WorkbenchDemo() {
  const [stage, setStage] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [visible, setVisible] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>('tasks');
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const rootRef = useRef<HTMLDivElement>(null);
  const autoplayedRef = useRef(false);
  const mobileTabTouchedRef = useRef(false);

  useEffect(() => {
    if (!mobileTabTouchedRef.current) setMobileTab(tabForStage(stage));
  }, [stage]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => {
      setReducedMotion(query.matches);
      if (query.matches) {
        setStage(stages.length - 1);
        setPlaying(false);
      }
    };
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      const isVisible = entry.isIntersecting;
      setVisible(isVisible);
      if (!isVisible) {
        setPlaying(false);
        return;
      }
      if (!autoplayedRef.current && !reducedMotion) {
        autoplayedRef.current = true;
        setStage(0);
        setPlaying(true);
      }
    }, { threshold: 0.15 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [reducedMotion]);

  useEffect(() => {
    if (!playing || !visible || reducedMotion) return;
    if (stage >= stages.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      const next = stage + 1;
      setStage(next);
      if (next === stages.length - 1) setPlaying(false);
    }, stageDurations[stage]);
    return () => window.clearTimeout(timer);
  }, [playing, reducedMotion, stage, visible]);

  const togglePlayback = () => {
    if (reducedMotion) {
      setStage(stages.length - 1);
      setPlaying(false);
      return;
    }
    if (stage === stages.length - 1 && !playing) {
      mobileTabTouchedRef.current = false;
      setMobileTab('tasks');
      setStage(0);
    }
    setPlaying((current) => !current);
  };

  const replay = () => {
    if (reducedMotion) {
      setStage(stages.length - 1);
      setPlaying(false);
      return;
    }
    mobileTabTouchedRef.current = false;
    setMobileTab('tasks');
    setStage(0);
    setPlaying(true);
  };

  const selectStage = (index: number) => {
    mobileTabTouchedRef.current = false;
    setMobileTab(tabForStage(index));
    setStage(index);
    setPlaying(false);
  };

  const selectMobileTab = (tab: MobileTab) => {
    mobileTabTouchedRef.current = true;
    setMobileTab(tab);
  };

  return (
    <div className="workbench-demo" ref={rootRef} data-playing={playing && visible && !reducedMotion}>
      <div className="workbench-window">
        <header className="app-toolbar">
          <span className="toolbar-brand"><OrbitMark small /><b>gdm</b></span>
          <span className="toolbar-path">gdm / gdm/fix-login / ~/gdm-worktrees/fix-login</span>
          <span className={stage === 6 ? 'risk-label risk-label-proven' : 'risk-label'}>{stage === 6 ? '✓ VERIFIED' : 'RISK MEDIUM'}</span>
        </header>
        <div className="desktop-workbench">
          <TaskRail stage={stage} />
          <AgentLanes stage={stage} />
          <ProofRail stage={stage} />
        </div>
        <MobileWorkbench stage={stage} tab={mobileTab} onTabChange={selectMobileTab} />
        <footer className="app-statusbar">
          <span className="signal-active">● gdm state</span>
          <span>{stages[stage].count} proven</span>
          <span className={stage === 6 ? 'signal-proven' : stage === 1 ? 'signal-attention' : 'text-secondary'}>{stage === 6 ? '0 blockers' : stages[stage].taskState.toLowerCase()}</span>
          <OrbitDock stage={stage} />
          <span>STEP {String(stage + 1).padStart(2, '0')} / 07</span>
        </footer>
      </div>
      <div className="workbench-controls">
        <div className="playback-controls">
          <button type="button" onClick={togglePlayback} aria-label={playing ? 'Pause animation' : 'Play animation'}>{playing ? 'Ⅱ PAUSE' : '▶ PLAY'}</button>
          <button type="button" onClick={replay} aria-label="Replay animation">↻ REPLAY</button>
        </div>
        <div className="stage-picker" aria-label="Workbench 단계 직접 선택">
          {stages.map((item, index) => (
            <button
              type="button"
              className="stage-button"
              aria-label={`${index + 1}단계 ${item.tag}`}
              aria-pressed={stage === index}
              onClick={() => selectStage(index)}
              key={`${item.tag}-${index}`}
            >
              <span>{String(index + 1).padStart(2, '0')}</span>
              <small>{item.tag}</small>
            </button>
          ))}
        </div>
        <p className="stage-description" aria-live="polite" aria-atomic="true"><b>{stages[stage].title}</b><span>{stages[stage].detail}</span></p>
      </div>
      <p className="sr-only" role="status" aria-live="polite">현재 {stage + 1}단계, {stages[stage].tag}. {stages[stage].detail}</p>
    </div>
  );
}

function copyFallback(text: string) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const copyInstall = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(INSTALL);
    } catch {
      copyFallback(INSTALL);
    }
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1800);
  };

  const closeMenu = () => setMenuOpen(false);

  return (
    <>
      <a className="skip-link" href="#main-content">본문으로 건너뛰기</a>
      <header className="site-header">
        <div className="nav-shell">
          <a className="brand" href="#top" aria-label="Gidem 홈"><OrbitMark small /><span>Gidem</span></a>
          <button className="menu-toggle" type="button" aria-expanded={menuOpen} aria-controls="nav-links" onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? 'Close' : 'Menu'}</button>
          <nav id="nav-links" className={menuOpen ? 'nav-links nav-links-open' : 'nav-links'} aria-label="주요 탐색">
            <a href="#product" onClick={closeMenu}>Product</a>
            <a href="#workbench" onClick={closeMenu}>How it works</a>
            <a href="#harness" onClick={closeMenu}>gdm Harness</a>
            <a href="#safety" onClick={closeMenu}>Safety</a>
            <a href={GITHUB} target="_blank" rel="noreferrer" onClick={closeMenu}>GitHub ↗</a>
          </nav>
        </div>
      </header>

      <main id="main-content">
        <section className="hero shell" id="product">
          <div className="hero-copy" id="top">
            <p className="overline"><span aria-hidden="true" /> GHOSTTY-BASED NATIVE AGENT WORKBENCH</p>
            <h1>Agents run.<br />Evidence decides.</h1>
            <p className="hero-kicker">터미널은 그대로. 혼란만 걷어냅니다.</p>
            <p className="hero-description">Gidem은 실제 Ghostty 터미널과 여러 코딩 에이전트, 작업별 worktree, diff와 검증 증거를 한 창에 묶는 <strong>사람의 control surface</strong>입니다. gdm은 재실행 가능한 명령과 출력으로 작업의 끝을 판정합니다.</p>
            <div className="hero-actions">
              <a className="button button-primary" href="#workbench">동작 살펴보기 ↓</a>
              <a className="button button-secondary" href={GITHUB} target="_blank" rel="noreferrer">gdm GitHub ↗</a>
            </div>
            <dl className="hero-facts">
              <div><dt>TERMINAL</dt><dd>실제 interactive PTY</dd></div>
              <div><dt>LANES</dt><dd>Shell · Codex · Claude · Gemini</dd></div>
              <div><dt>GATE</dt><dd>exit code · output · SHA-256</dd></div>
            </dl>
          </div>
          <MotionSection className="hero-proof-motion" label="hero-proof" once><HeroProofRail /></MotionSection>
        </section>

        <section className="page-section workbench-section" id="workbench">
          <div className="shell">
            <header className="section-heading section-heading-inline">
              <p>SEC 02 / WORKBENCH</p>
              <h2>한 작업이 창 하나를 통과합니다.</h2>
              <span>Tasks, terminal lane, Proof Rail이 같은 상태를 공유합니다. 아래는 fix-login 작업의 실제 7단계입니다.</span>
            </header>
            <WorkbenchDemo />
          </div>
        </section>

        <section className="page-section system-section" id="harness">
          <div className="shell">
            <header className="section-heading section-heading-inline">
              <p>SEC 03 / SURFACE + ENGINE</p>
              <h2>Gidem이 작업을 보여주고, gdm이 완료를 증명합니다.</h2>
            </header>
            <MotionSection className="system-motion" label="surface-engine-handoff">
            <div className="system-map">
              <aside className="one-task">
                <span>ONE TASK</span>
                <strong>fix-login</strong>
                <p>같은 worktree와 계약을 제품 화면과 결정적 엔진이 함께 봅니다.</p>
                <small>CONTRACT ↓</small>
              </aside>
              <div className="system-layers">
                <div className="system-layer">
                  <header><strong>Gidem</strong><span className="signal-active">PRODUCT SURFACE</span><small>사람이 작업과 에이전트를 다루는 화면</small></header>
                  <ol>
                    <li><span>01</span>Ghostty 기반 실제 PTY</li>
                    <li><span>02</span>task별 격리 worktree</li>
                    <li><span>03</span>멀티 에이전트 lane</li>
                    <li><span>04</span>Files, Editor, Diff, Journal, Evidence</li>
                    <li><span>05</span>Agent Activity와 명시적 Handoff</li>
                  </ol>
                </div>
                <div className="handoff-line"><span>HANDOFF</span><i /><span className="handoff-packet" aria-hidden="true" /><code>gdm protocol handoff --to-role auditor</code><i /><span>↓</span></div>
                <div className="system-layer system-layer-engine">
                  <header><strong>gdm</strong><span className="signal-proven">DETERMINISTIC ENGINE</span><small>모델을 호출하지 않고 완료를 판정하는 게이트</small></header>
                  <ol>
                    <li><span>01</span>작업 계약</li>
                    <li><span>02</span>승인된 검증 계획</li>
                    <li><span>03</span>재현 명령 직접 실행</li>
                    <li><span>04</span>출력, exit code, SHA-256 증거</li>
                    <li className="signal-proven"><span>05</span>모든 항목이 통과해야 done</li>
                  </ol>
                </div>
              </div>
            </div>
            </MotionSection>
          </div>
        </section>

        <section className="page-section proof-model-section" id="proof-model">
          <div className="shell">
            <header className="section-heading">
              <p>SEC 04 / THE PROOF LOOP</p>
              <h2>계획에서 증거까지, 상태가 끊기지 않습니다.</h2>
              <span>에이전트가 바뀌어도 같은 계약과 같은 check를 봅니다.</span>
            </header>
            <MotionSection className="proof-loop-motion" label="proof-loop">
              <ol className="proof-flow" aria-label="gdm 검증 흐름">
                {flow.map((item, index) => <li style={{ '--motion-order': index } as CSSProperties} key={item}><span>{String(index + 1).padStart(2, '0')}</span><strong>{item}</strong><b className="flow-node" aria-hidden="true" />{index < flow.length - 1 && <i aria-hidden="true">→</i>}</li>)}
              </ol>
              <span className="proof-route" aria-hidden="true"><i /></span>
            </MotionSection>
            <div className="capability-table">
              <article><span>01</span><h3>Ghostty terminal</h3><p>vim, ssh, IME와 익숙한 shortcut을 유지하는 실제 interactive PTY입니다.</p><code>TERMINAL FIRST</code></article>
              <article><span>02</span><h3>Task worktree</h3><p>작업마다 branch와 worktree를 격리해 기존 변경과 프로젝트 본체를 보존합니다.</p><code>ISOLATED SCOPE</code></article>
              <article><span>03</span><h3>Multi-agent lanes</h3><p>Codex, Claude, Gemini가 독립 lane에서 실행되고 PRIMARY와 Handoff를 사람이 봅니다.</p><code>HUMAN OWNED</code></article>
              <article><span>04</span><h3>Proof Rail</h3><p>OPEN → RUNNING → PROVEN과 blocker를 glyph, 문구, counter로 함께 표시합니다.</p><code>VISIBLE EVIDENCE</code></article>
            </div>
          </div>
        </section>

        <section className="page-section boundaries-section" id="safety">
          <div className="shell">
            <header className="section-heading section-heading-inline">
              <p>SEC 05 / CLEAR BOUNDARIES</p>
              <h2>완료 메시지와 완료된 증거는 다릅니다.</h2>
              <span>제품을 가장 빨리 이해시키는 방법은 오해할 지점을 먼저 없애는 것입니다.</span>
            </header>
            <MotionSection className="boundary-motion" label="claim-verdict">
            <div className="boundary-console-grid">
              <div className="boundary-list">
                <div><span className="signal-proven">GIDEM</span><strong>사람의 control surface</strong><p>실제 터미널과 agent lane을 보고, 승인·중지·handoff·proof를 통제합니다.</p></div>
                <div><span className="signal-blocked">NOT A REPLACEMENT</span><strong>터미널을 없애지 않음</strong><p>에디터 안에 명령을 숨기는 GUI가 아닙니다. 익숙한 터미널을 중심에 둡니다.</p></div>
                <div><span className="signal-blocked">NOT A CLAIM</span><strong>완료 문장을 믿지 않음</strong><p>“완료했습니다”는 신호일 뿐입니다. gdm이 실행한 check와 evidence가 판정합니다.</p></div>
              </div>
              <article className="incident-console" aria-label="에이전트 주장과 gdm 검증 결과가 다른 예시">
                <header><span>gdm / verification result</span><span className="verdict-route" aria-hidden="true"><i /></span><strong className="signal-blocked">✕ BLOCKED</strong></header>
                <div className="incident-agent"><span className="signal-active">AGENT</span><strong>완료했습니다.</strong><small>UNVERIFIED CLAIM</small></div>
                <div className="incident-output">
                  <p><span className="signal-active">$</span> gdm pass c2 --slug fix-login</p>
                  <p className="signal-blocked">✕ c2 FAILED · exit 1</p>
                  <p>expected: session boundary preserved</p>
                  <p>observed: owner changed outside worktree</p>
                  <p>evidence: output captured · sha256 locked</p>
                </div>
                <footer><span className="signal-attention">◇ 사용자 확인 필요</span><span>실패를 숨기지 않고 원인과 다음 행동을 분리합니다.</span></footer>
              </article>
            </div>
            <div className="safety-rail" aria-label="승인 권한 개인정보 안전 경계">
              <article><span>01 · APPROVAL</span><strong>승인된 계획만 실행</strong><p>계획 fingerprint가 바뀌면 READY를 취소하고 다시 검토합니다.</p></article>
              <article><span>02 · PERMISSION</span><strong>완료와 전달 권한을 분리</strong><p>done은 검증 완료일 뿐 commit, push, PR 권한을 자동으로 만들지 않습니다.</p></article>
              <article><span>03 · PRIVACY</span><strong>민감한 내용은 export 거부</strong><p>credential처럼 보이는 문자열을 감지하면 snapshot export가 fail-closed 됩니다.</p></article>
            </div>
            </MotionSection>
          </div>
        </section>

        <section className="page-section cli-section" id="cli">
          <div className="shell cli-layout">
            <header className="section-heading">
              <p>SEC 06 / THE ACTUAL CLI</p>
              <h2>말보다 명령과 증거.</h2>
              <span>gdm은 모델이 아닙니다. 승인된 check를 직접 실행하는 결정적 검증 엔진입니다.</span>
            </header>
            <div className="cli-console">
              <header><span>TERMINAL / gdm</span><button type="button" onClick={copyInstall} aria-label="설치 명령 복사">{copied ? 'Copied ✓' : 'Copy install'}</button></header>
              <pre><code><span className="signal-active">$</span> gdm plan init --slug fix-login --brief "로그인 오류 수정" \{`\n`}  --require "기존 로그인 동작 보존" --forbid "자동 커밋"{`\n`}<span className="signal-active">$</span> gdm plan add --slug fix-login --desc "로그인 회귀 테스트" \{`\n`}  --cmd "bun test login" --expect "exit 0" --kind regression{`\n`}<span className="signal-active">$</span> gdm pass c1 --red --slug fix-login{`\n`}<span className="signal-active">$</span> gdm pass c1 --slug fix-login{`\n`}<span className="signal-active">$</span> gdm done --slug fix-login{`\n\n`}<span className="signal-proven">✓ 3/3 PROVEN · 0 BLOCKERS</span></code></pre>
              <dl className="evidence-record">
                <div><dt>COMMAND</dt><dd>bun test login</dd></div>
                <div><dt>RESULT</dt><dd className="signal-proven">exit 0</dd></div>
                <div><dt>EVIDENCE</dt><dd>output captured · sha256 2f5e8c1b…</dd></div>
              </dl>
            </div>
            <div className="install-strip">
              <div><span>gdm CLI 설치</span><strong>macOS · Linux / Bun·clone 불필요</strong></div>
              <code>{INSTALL}</code>
              <button type="button" onClick={copyInstall}>{copied ? '복사됨 ✓' : '복사'}</button>
            </div>
            <p className="availability-note"><span className="signal-attention">◇ Gidem app</span> Gidem macOS 앱의 공개 다운로드가 아닙니다. 위 명령은 <strong>gdm CLI와 skill pack만 설치</strong>합니다.</p>
          </div>
        </section>

        <section className="closing-section">
          <MotionSection className="shell closing-layout closing-motion" label="final-proof-dock">
            <div><p>SEC 07 / START WITH THE PROOF</p><h2>완료했다고 말하지 말고,<br />증명하세요.</h2></div>
            <div><div className="closing-dock" role="img" aria-label="검증 신호가 Orbit G에 도킹해 완료 상태가 됩니다"><span className="closing-track" aria-hidden="true" /><span className="closing-node" aria-hidden="true" /><OrbitMark small /></div><p>Gidem은 작업을 사람이 통제하게 하고, gdm은 실행 가능한 증거로 완료를 판정합니다.</p><a className="button button-primary" href={GITHUB} target="_blank" rel="noreferrer">GitHub에서 gdm 보기 ↗</a></div>
          </MotionSection>
        </section>
      </main>

      <footer className="site-footer"><div className="shell"><span>GIDEM / GDM</span><span>TERMINAL FIRST · EVIDENCE DECIDES</span><a href={GITHUB} target="_blank" rel="noreferrer">github.com/Gdm0714/gdm ↗</a></div></footer>
    </>
  );
}

export default App;
