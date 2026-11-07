'use strict';

const main = document.querySelector('#main');
const modal = document.querySelector('#modal');
const toast = document.querySelector('#toast');
const db = new Promise((resolve, reject) => {
  const request = indexedDB.open('ready-for-handoff', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('workspace');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
let projects = [];
let current = '';
let selected = '';
let role = '';
let filter = 'all';
let recorder;
let recording;
let recordingURL;
let toastTimer;
let midnightTimer;
let displayedDay;

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (action, label, style = 'btn', id = '') => '<button type="button" class="' + style + '" data-action="' + action + '" data-id="' + esc(id) + '">' + esc(label) + '</button>';
const pill = (label, style = '') => '<span class="pill ' + style + '">' + esc(label) + '</span>';
const project = () => projects.find(item => item.id === current);
const task = () => project()?.tasks.find(item => item.id === selected);
const latest = item => item.revisions.at(-1);
const accepted = rev => Object.values(rev.decisions).filter(d => d.kind === 'accepted').length;
const dates = item => item.start + ' → ' + item.due;
const labels = {scheduled:'Scheduled', active:'In progress', blocked:'Blocked', review:'In review', changes:'Changes requested', complete:'✓ Complete'};

function localDay(now = new Date()) {
  const pad = number => String(number).padStart(2, '0');
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

function refreshSchedule() {
  const now = new Date();
  if (localDay(now) !== displayedDay) render();
  clearTimeout(midnightTimer);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  midnightTimer = setTimeout(refreshSchedule, midnight - now);
}

function notify(message) {
  toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.textContent = ''; }, 4200);
}

async function save(next) {
  const connection = await db;
  await new Promise((resolve, reject) => {
    const tx = connection.transaction('workspace', 'readwrite');
    tx.objectStore('workspace').put(next, 'projects');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
  projects = next;
}

async function change(edit, message) {
  const next = structuredClone(projects);
  const p = next.find(item => item.id === current);
  edit(next, p, p?.tasks.find(item => item.id === selected));
  await save(next);
  if (modal.open) modal.close();
  render();
  if (message) notify(message);
}

function status(item, p) {
  const rev = latest(item);
  if (rev) {
    if (rev.reviewers.every(name => Object.hasOwn(rev.decisions,name) && rev.decisions[name].kind === 'accepted')) return 'complete';
    if (Object.values(rev.decisions).some(d => d.kind === 'changes')) return 'changes';
    return 'review';
  }
  if (dependencies(item, p).some(dep => status(dep, p) !== 'complete')) return 'blocked';
  return item.started || item.start <= localDay() ? 'active' : 'scheduled';
}

function dependencies(item, p) {
  return item.deps.map(id => p.tasks.find(dep => dep.id === id)).filter(Boolean);
}

function nextAction(item, p) {
  const state = status(item, p);
  const rev = latest(item);
  if (state === 'blocked') return 'Waiting for ' + dependencies(item, p).filter(dep => status(dep, p) !== 'complete').map(dep => dep.title).join(', ');
  if (state === 'review') return accepted(rev) + ' of ' + rev.reviewers.length + ' accepted · Waiting for ' + rev.reviewers.filter(name => !Object.hasOwn(rev.decisions,name)).join(', ');
  if (state === 'changes') return item.owner + ' · Revise and resubmit';
  if (state === 'complete') return 'Revision ' + rev.number + ' accepted by everyone';
  return state === 'scheduled'
    ? 'Starts ' + item.start + ' at 12:00 a.m. · ' + item.owner + ' can start early'
    : item.owner + ' · Submit evidence';
}

function person(name,members) {
  const initials = name.trim().split(/\s+/u).slice(0,2).map(part => Array.from(part)[0]).join('').toUpperCase();
  const color = Math.max(0,members.indexOf(name)) % 4;
  return '<span class="person"><span class="avatar avatar-' + color + '" aria-hidden="true">' + esc(initials) + '</span><span class="person-name">' + esc(name) + '</span></span>';
}

function render() {
  displayedDay = localDay();
  const p = project();
  document.querySelector('#projects').innerHTML = projects.map(item => button('project', item.title, 'project-link' + (current === item.id ? ' active' : ''), item.id)).join('');
  document.querySelector('#crumb').innerHTML = p ? '<button class="ghost" data-action="home">Projects</button><span>/</span>' + esc(p.title) : 'Workspace <span>/</span> Projects';
  document.querySelector('#identity').innerHTML = p ? '<label><span>Acting as</span><select id="role">' + p.members.map(name => '<option' + (role === name ? ' selected' : '') + '>' + esc(name) + '</option>').join('') + '</select></label>' : '';
  main.innerHTML = task() ? detail(task(), p) : p ? workspace(p) : home();
}

function home() {
  const tiles = projects.map(p => '<button class="card" data-action="project" data-id="' + esc(p.id) + '"><h3>' + esc(p.title) + '</h3><p>' + p.tasks.length + ' tasks · ' + p.members.length + ' teammates</p></button>').join('');
  return '<div class="pagehead"><div><h1>Projects</h1><p class="sub">Track handoffs and see what’s holding up the next step.</p></div>' + (projects.length ? button('new-project','＋ New project') : '') + '</div>' + (projects.length ? '<div class="cards">' + tiles + '</div>' : '<section class="empty"><div class="art" aria-hidden="true">' + '<i></i>'.repeat(9) + '</div><h2>Create your first project</h2><p>Add your team, plan the work, and review the evidence for each handoff.</p>' + button('new-project','＋ New project') + '</section>');
}

function workspace(p) {
  const items = p.tasks.map(task => ({task,state:status(task,p)}));
  const complete = items.filter(item => item.state === 'complete').length;
  const blocked = items.filter(item => item.state === 'blocked').length;
  const pending = items.length - complete;
  const progress = items.length ? Math.round(100 * complete / items.length) : 0;
  const tabs = [['all','All tasks',items.length],['pending','Pending',pending],['complete','Completed',complete],['blocked','Blocked',blocked]];
  const visible = items.filter(({state}) => filter === 'all' || (filter === 'pending' ? state !== 'complete' : filter === state));
  const cards = visible.map(({task,state}) => taskCard(task,state,p)).join('');
  const board = items.length
    ? '<section class="task-board" aria-labelledby="task-board-title"><h2 id="task-board-title">Tasks</h2><div class="filters" aria-label="Filter tasks">' +
      tabs.map(([id,label,count]) => '<button class="tab" type="button" data-action="filter" data-id="' + id + '" aria-pressed="' + (filter === id) + '">' + label + ' <span class="tab-count">' + count + '</span></button>').join('') +
      '</div><div class="list">' + (cards || '<p class="filter-empty muted">No ' + (filter === 'complete' ? 'completed' : filter) + ' tasks.</p>') + '</div></section>'
    : '<section class="empty"><h2>Plan the first task</h2><p>Set an owner, planned dates, and the evidence the team should review.</p>' + button('new-task','＋ Add task') + '</section>';
  const stats = [['Pending',pending,'◷','pending-metric'],['Completed',complete,'✓','complete-metric'],['Blocked',blocked,'!','blocked-metric']];
  return '<div class="pagehead"><h1>' + esc(p.title) + '</h1><div class="actions">' + button('new-task','＋ Add task') + button('delete-project','Delete project','ghost danger-outline') + '</div></div>' +
    '<section class="project-summary" aria-label="Project overview"><div class="summary-grid"><div><h2>Team</h2><div class="team-list">' + p.members.map(name => person(name,p.members)).join('') + '</div></div>' +
    '<div><div class="progress-label"><h2>Project progress</h2><strong>' + progress + '%</strong></div><progress aria-label="Project progress" max="100" value="' + progress + '"></progress><p class="muted">' + complete + ' of ' + items.length + ' tasks complete</p></div></div>' +
    '<div class="stats">' + stats.map(([label,count,icon,style]) => '<div class="stat metric ' + style + '"><span class="metric-icon" aria-hidden="true">' + icon + '</span><div><p>' + label + '</p><strong>' + count + '</strong></div></div>').join('') + '</div></section>' + board;
}

function taskCard(item,state,p) {
  const icons = {scheduled:'◷',active:'›',blocked:'!',review:'…',changes:'↺',complete:'✓'};
  return '<button type="button" class="task-row task-' + state + '" data-action="task" data-id="' + esc(item.id) + '">' +
    '<span class="task-icon" aria-hidden="true">' + icons[state] + '</span><span class="task-main"><strong>' + esc(item.title) + '</strong><small>' + esc(dates(item)) + '</small></span>' +
    '<span class="task-meta">' + person(item.owner,p.members) + pill(labels[state],state) + '</span>' +
    '<small class="task-next">' + esc(nextAction(item,p)) + '</small><span class="task-arrow" aria-hidden="true">↗</span></button>';
}

function fileControls(files, revisionIndex, reviewerIndex = '') {
  return files.map((file,i) => '<div class="attachment"><span>' + esc(file.name) + '</span>' + button('download','Download','ghost',[revisionIndex,reviewerIndex,i].join('|')) + '</div>').join('');
}

function detail(item,p) {
  const state = status(item,p);
  const rev = latest(item);
  const index = item.revisions.length - 1;
  const prior = dependencies(item,p);
  const downstream = p.tasks.filter(t => t.deps.includes(item.id));
  const decision = rev && Object.hasOwn(rev.decisions,role);
  const ownerActions = role === item.owner
    ? state === 'scheduled' ? button('start','Start task') : state === 'active' || state === 'changes' ? button('submit','Submit evidence') : ''
    : '';
  const reviewActions = state === 'review' && rev.reviewers.includes(role) && !decision
    ? '<div class="actions">' + button('accept','Accept revision ' + rev.number) + button('request','Request changes','ghost') + '</div>' : '';
  const evidence = rev ? fileControls(rev.files,index) : '<p class="muted">Evidence will appear after the owner submits it.</p>';
  const reviews = rev ? '<p class="muted">' + accepted(rev) + ' of ' + rev.reviewers.length + ' accepted · Revision ' + rev.number + '</p>' + rev.reviewers.map(name => {
    const result = Object.hasOwn(rev.decisions,name) && rev.decisions[name].kind;
    return '<div class="review-row">' + person(name,p.members) + (result === 'accepted' ? pill('Accepted','complete') : result === 'changes' ? pill('Changes requested','changes') : pill('Pending','scheduled')) + '</div>';
  }).join('') : '<p class="muted">Everyone reviews once evidence is submitted.</p>';
  const history = item.revisions.map((r,i) => '<details class="event"' + (i === index && state === 'changes' ? ' open' : '') + '><summary>Revision ' + r.number + ' · ' + esc(r.date) + '</summary>' + fileControls(r.files,i) + Object.entries(r.decisions).map(([name,d]) => {
    const reviewerIndex = r.reviewers.indexOf(name);
    return '<div class="event"><strong>' + esc(name) + ' · ' + (d.kind === 'accepted' ? 'Accepted' : 'Requested changes') + '</strong>' + (d.note ? '<p>' + esc(d.note) + '</p>' : '') + fileControls(d.files ?? [],i,reviewerIndex) + (d.audio ? '<p>' + button('play','Play recorded audio','ghost',[i,reviewerIndex].join('|')) + '</p>' : '') + '</div>';
  }).join('') + '</details>').reverse().join('');
  const related = items => items.length ? items.map(t => '<div class="review-row">' + button('task',t.title,'ghost',t.id) + pill(labels[status(t,p)],status(t,p)) + '</div>').join('') : '<p class="muted">None</p>';
  return button('back','← Project tasks','ghost back') + '<div class="pagehead"><div><h1>' + esc(item.title) + '</h1><div class="detail-owner">' + person(item.owner,p.members) + '<span class="muted">Planned · ' + esc(dates(item)) + '</span></div></div>' + pill(labels[state],state) + '</div><div class="next"><strong>' + esc(nextAction(item,p)) + '</strong></div>' +
    (ownerActions || reviewActions ? '<div class="actions" style="margin-bottom:14px">' + ownerActions + reviewActions + '</div>' : '') +
    '<div class="detail-grid"><div class="stack"><section class="panel"><h2>Evidence' + (rev ? ' · R' + rev.number : '') + '</h2>' + evidence + '</section><section class="panel"><h3>Completion criteria</h3><p>' + esc(item.criteria) + '</p><h3 style="margin-top:14px">Required evidence</h3><p>' + esc(item.evidence) + '</p></section>' + (history ? '<section class="panel"><h3>Revision history</h3>' + history + '</section>' : '') + '</div><div class="stack"><section class="panel"><h3>Team review</h3>' + reviews + '</section><section class="panel"><h3>Prerequisites</h3>' + related(prior) + '<h3 style="margin-top:15px">Dependent tasks</h3>' + related(downstream) + '</section></div></div>';
}

const field = (label, name, options = '') => '<label>' + label + '<input name="' + name + '" ' + options + '></label>';
const area = (label, name, options = '') => '<label>' + label + '<textarea name="' + name + '" ' + options + '></textarea></label>';

function form(title, kind, content, confirm) {
  const deleting = kind === 'delete-project';
  modal.innerHTML = '<form id="edit" data-kind="' + kind + '"><div class="formtop"><h2 id="dialog-title">' + title + '</h2>' + (deleting ? '' : button('close','Close','ghost')) + '</div>' + content + '<p class="error" role="alert"></p><div class="actions">' +
    (deleting ? '<button type="button" class="ghost" data-action="close" autofocus>Cancel</button>' : '') +
    '<button class="btn' + (deleting ? ' danger' : '') + '" type="submit">' + confirm + '</button></div></form>';
  modal.setAttribute('aria-labelledby','dialog-title');
  modal.showModal();
}

function error(message) {
  const target = modal.querySelector('.error');
  if (target) target.textContent = message;
  else notify(message);
}

function options(members) {
  return members.map(name => '<option>' + esc(name) + '</option>').join('');
}

async function recordAudio() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    error('Audio recording is unavailable here. You can write a note or attach a file.');
    return;
  }
  const button = modal.querySelector('[data-action=record]');
  if (recorder?.state === 'recording') {
    recorder.stop();
    return;
  }
  button.disabled = true;
  const activeForm = modal.querySelector('form');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    if (!modal.open || modal.querySelector('form') !== activeForm) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    const chunks = [];
    const capture = new MediaRecorder(stream);
    recorder = capture;
    capture.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    capture.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      if (!modal.open || recorder !== capture) return;
      recording = new Blob(chunks,{type:capture.mimeType});
      if (recordingURL) URL.revokeObjectURL(recordingURL);
      recordingURL = URL.createObjectURL(recording);
      const audio = modal.querySelector('audio');
      audio.src = recordingURL;
      audio.hidden = false;
      button.textContent = 'Record again';
      updateFeedback();
    };
    capture.start();
    button.textContent = 'Stop recording';
    error('');
  } catch {
    error('Could not access the microphone. You can write a note or attach a file.');
  } finally { button.disabled = false; }
}

function updateFeedback() {
  const f = modal.querySelector('form[data-kind=request]');
  if (!f) return;
  f.querySelector('[type=submit]').disabled = !(f.elements.note.value.trim() || f.elements.files.files.length || recording?.size);
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url),15000);
}

modal.addEventListener('close', () => {
  if (recorder?.state === 'recording') recorder.stop();
  recorder = undefined;
  recording = undefined;
  if (recordingURL) URL.revokeObjectURL(recordingURL);
  recordingURL = undefined;
});
modal.addEventListener('input',updateFeedback);
modal.addEventListener('change',updateFeedback);
document.addEventListener('change', e => {
  if (e.target.id === 'role') {
    role = e.target.value;
    const prior = role;
    render();
    document.querySelector('#role').value = prior;
    document.querySelector('#role').focus();
  }
});

let busy = false;
document.addEventListener('click', async e => {
  const control = e.target.closest('[data-action],.brand');
  if (!control || busy) return;
  const action = control.dataset.action ?? 'home';
  const id = control.dataset.id;
  const p = project();
  const item = task();
  e.preventDefault();
  try {
    if (action === 'home') { current = ''; selected = ''; render(); }
    if (action === 'project') { current = id; selected = ''; filter = 'all'; role = project().members[0]; render(); }
    if (action === 'back') { selected = ''; render(); }
    if (action === 'task') { selected = id; render(); main.querySelector('h1').setAttribute('tabindex','-1'); main.querySelector('h1').focus(); }
    if (action === 'filter') { filter = id; render(); main.querySelector('[aria-pressed=true]').focus(); }
    if (action === 'close') modal.close();
    if (action === 'delete-project' && p) {
      form('Delete project?', 'delete-project',
        '<p><strong>' + esc(p.title) + '</strong> and all its tasks, attachments, and reviews will be permanently removed from this browser.</p>',
        'Delete project');
    }
    if (action === 'new-project') form('Create a project','project',field('Project title','title','required maxlength="120"') + area('Team members (one name per line)','members','required maxlength="1200"'), 'Create project');
    if (action === 'new-task') form('Add task','task',field('Task title','title','required maxlength="120"') + '<label>Owner<select name="owner">' + options(p.members) + '</select></label><div class="formgrid">' + field('Planned start','start','required type="date"') + field('Due date','due','required type="date"') + '</div>' + area('Required evidence','evidence','required') + area('Completion criteria','criteria','required') +
      (p.tasks.length ? '<fieldset><legend>Prerequisites</legend>' + p.tasks.map(t => '<label><input type="checkbox" name="deps" value="' + esc(t.id) + '">' + esc(t.title) + '</label>').join('') + '</fieldset>' : '') + '<p class="muted">Tasks start at 12:00 a.m. local time on the planned date once prerequisites are complete. The owner can start an unblocked task early. All teammates review the submitted revision.</p>','Add task');
    if (action === 'start' && role === item.owner && status(item,p) === 'scheduled') {
      busy = true;
      await change((_,__,t) => { t.started = true; },'Task started.');
    }
    if (action === 'submit' && role === item.owner) form('Submit evidence','submit','<p class="muted">Required evidence · ' + esc(item.evidence) + '</p>' + field('Attach evidence','files','required type="file" multiple'),'Submit revision ' + (item.revisions.length + 1));
    if (action === 'accept' && status(item,p) === 'review' && !Object.hasOwn(latest(item).decisions,role)) {
      busy = true;
      await change((_,__,t) => { Object.defineProperty(latest(t).decisions,role,{value:{kind:'accepted'},enumerable:true,configurable:true,writable:true}); },'Acceptance recorded.');
    }
    if (action === 'request') {
      form('Request changes','request','<p class="muted">Add a written note, a file, or recorded audio.</p>' + area('Written note','note') + field('Attach feedback','files','type="file" multiple') + '<div>' + button('record','Record audio','ghost') + '<audio hidden controls></audio></div>','Send change request');
      updateFeedback();
    }
    if (action === 'record') await recordAudio();
    if (action === 'download' || action === 'play') {
      const [rev,reviewer,file] = id.split('|');
      const r = item.revisions[Number(rev)];
      const d = r.decisions[r.reviewers[Number(reviewer)]];
      if (action === 'download') download((reviewer === '' ? r.files : d.files)[Number(file)]);
      else {
        const audio = document.createElement('audio');
        const url = URL.createObjectURL(d.audio);
        audio.src = url;
        audio.controls = true;
        control.replaceWith(audio);
        audio.addEventListener('ended',() => URL.revokeObjectURL(url),{once:true});
        await audio.play();
      }
    }
  } catch (err) {
    console.error(err);
    error('Could not complete the action. Please try again.');
  } finally { busy = false; }
});

modal.addEventListener('submit',async e => {
  e.preventDefault();
  if (busy) return;
  const f = e.target;
  const data = new FormData(f);
  const value = key => String(data.get(key) ?? '').trim();
  const files = () => [...f.elements.files.files];
  const kind = f.dataset.kind;
  const submit = f.querySelector('[type=submit]');
  busy = true;
  submit.disabled = true;
  error('');
  try {
    if (kind === 'delete-project') {
      await save(projects.filter(item => item.id !== current));
      current = '';
      selected = '';
      role = '';
      filter = 'all';
      modal.close();
      render();
      main.querySelector('h1').setAttribute('tabindex','-1');
      main.querySelector('h1').focus();
      notify('Project deleted.');
    }
    if (kind === 'project') {
      const members = [...new Set(value('members').split('\n').map(s => s.trim()).filter(Boolean))];
      if (!value('title') || members.length < 2) throw new Error('Enter a project title and at least two distinct teammate names.');
      const p = {id:crypto.randomUUID(),title:value('title'),members,tasks:[]};
      await save([...projects,p]);
      current = p.id;
      selected = '';
      role = members[0];
      filter = 'all';
      modal.close();
      render();
    }
    if (kind === 'task') {
      if (value('due') < value('start')) throw new Error('The due date must be on or after the planned start.');
      if (!['title','criteria','evidence'].every(key => value(key))) throw new Error('Enter a task title, criteria, and required evidence.');
      const item = {id:crypto.randomUUID(),title:value('title'),owner:value('owner'),start:value('start'),due:value('due'),criteria:value('criteria'),evidence:value('evidence'),deps:data.getAll('deps'),revisions:[]};
      await change((_,p) => { p.tasks.push(item); },'Task added.');
    }
    if (kind === 'submit') {
      if (!files().length) throw new Error('Attach evidence before submitting.');
      if (role !== task().owner || !['active','changes'].includes(status(task(),project()))) throw new Error('This task cannot be submitted in its current state.');
      await change((_,p,t) => {
        t.revisions.push({number:t.revisions.length+1,files:files(),reviewers:[...p.members],decisions:Object.create(null),date:new Date().toLocaleString()});
      },'Evidence submitted for team review.');
    }
    if (kind === 'request') {
      if (recorder?.state === 'recording') throw new Error('Stop recording before sending your feedback.');
      if (!(value('note') || files().length || recording?.size)) throw new Error('Add a note, an attachment, or audio.');
      await change((_,__,t) => {
        Object.defineProperty(latest(t).decisions,role,{value:{kind:'changes',note:value('note'),files:files(),audio:recording},enumerable:true,configurable:true,writable:true});
      },'Change request sent to the task owner.');
    }
  } catch (err) {
    error(err.name === 'QuotaExceededError' ? 'Browser storage is full. Try smaller attachments.' : err.message || 'Could not save the change.');
    submit.disabled = false;
    updateFeedback();
  } finally { busy = false; }
});

db.then(connection => {
  const request = connection.transaction('workspace').objectStore('workspace').get('projects');
  request.onsuccess = () => {
    projects = request.result ?? [];
    render();
    refreshSchedule();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshSchedule();
    });
    window.addEventListener('focus', refreshSchedule);
  };
  request.onerror = () => { main.textContent = 'Could not open the local workspace.'; };
}).catch(() => { main.textContent = 'Browser storage is unavailable.'; });

