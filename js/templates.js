// Built-in starter templates. Coordinates are in board (world) units.
// Users can also save any board as a template (stored in Drive › Whiteboard/templates).
const Y = '#fff59d', O = '#ffcc80', P = '#f8bbd0', B = '#b3e5fc', G = '#c5e1a5', V = '#e1bee7';
let n = 0;
const id = () => 'tpl-item-' + (++n);
const text = (x, y, t, fontSize = 28, color = 'ink') => ({ id: id(), type: 'text', x, y, text: t, fontSize, color });
const note = (x, y, t, color = Y, w = 200, h = 160) => ({ id: id(), type: 'note', x, y, w, h, text: t, color });
const rect = (x1, y1, x2, y2, color = 'ink', size = 2) => ({ id: id(), type: 'rect', x1, y1, x2, y2, color, size });
const line = (x1, y1, x2, y2, color = 'ink', size = 2) => ({ id: id(), type: 'line', x1, y1, x2, y2, color, size });
const arrow = (x1, y1, x2, y2, color = 'ink', size = 3) => ({ id: id(), type: 'arrow', x1, y1, x2, y2, color, size });
const ellipse = (x1, y1, x2, y2, color = 'ink', size = 2) => ({ id: id(), type: 'ellipse', x1, y1, x2, y2, color, size });

function column(x, y, title, w, h, color, notes) {
  const out = [rect(x, y, x + w, y + h, 'ink', 2), text(x + 16, y + 14, title, 26)];
  notes.forEach((t, i) => out.push(note(x + 20, y + 70 + i * 180, t, color, w - 40, 160)));
  return out;
}

// Kanban: each column (frame + bold header) is grouped and LOCKED, so it stays put while notes move over it.
function kanbanColumn(x, title, color, notes, n) {
  const g = 'tpl-kanban-col-' + n;
  return [
    { ...rect(x, 0, x + 300, 760, 'ink', 2), locked: true, groupId: g },
    { ...text(x + 16, 14, title, 26), bold: true, locked: true, groupId: g },
    ...notes.map((t, i) => note(x + 30, 70 + i * 180, t, color, 240, 150)),
  ];
}

export const BUILTIN_TEMPLATES = [
  { id: 'tpl-blank', name: 'Blank', background: 'grid', builtin: true, items: [] },
  {
    id: 'tpl-meeting-notes', name: 'Meeting Notes', background: 'grid', builtin: true,
    items: [
      text(0, -120, 'Meeting: <title>', 40),
      text(0, -66, 'Date: {{date}}    Attendees: …', 22),
      ...column(0, 0, 'Agenda', 300, 600, B, ['1. …', '2. …', '3. …']),
      ...column(330, 0, 'Notes', 300, 600, Y, ['Key point…', 'Key point…']),
      ...column(660, 0, 'Decisions', 300, 600, G, ['Decided…']),
      ...column(990, 0, 'Action items', 300, 600, P, ['Who / What / When', 'Who / What / When']),
    ],
  },
  {
    id: 'tpl-brainstorm', name: 'Brainstorm', background: 'dots', builtin: true,
    items: (() => {
      const cx = 0, cy = 0, r = 360, out = [];
      const labels = ['Idea', 'Idea', 'Idea', 'Idea', 'Idea', 'Idea'];
      const colors = [Y, O, P, B, G, V];
      labels.forEach((t, i) => {
        const a = (i / labels.length) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        out.push(line(cx + Math.cos(a) * 130, cy + Math.sin(a) * 100, x - Math.cos(a) * 90, y - Math.sin(a) * 70, 'ink', 2));
        out.push(note(x - 90, y - 70, t, colors[i], 180, 140));
      });
      out.push(ellipse(cx - 150, cy - 100, cx + 150, cy + 100, 'ink', 3));
      out.push(text(cx - 110, cy - 20, 'Central topic', 30));
      out.push(text(cx - 300, cy - 560, 'Brainstorm: <question>', 40));
      return out;
    })(),
  },
  {
    id: 'tpl-project-plan', name: 'Project Plan', background: 'grid', builtin: true,
    items: [
      text(0, -170, 'Project: <name>', 40),
      text(0, -116, 'Goal: …    Deadline: …    Owner: …', 22),
      arrow(0, -40, 1260, -40, 'ink', 3),
      text(0, -80, 'Kick-off', 18), text(410, -80, 'Milestone 1', 18), text(820, -80, 'Milestone 2', 18), text(1180, -80, 'Launch', 18),
      ...column(0, 0, 'To do', 300, 600, Y, ['Task…', 'Task…', 'Task…']),
      ...column(320, 0, 'In progress', 300, 600, B, ['Task…']),
      ...column(640, 0, 'Blocked', 300, 600, P, ['Blocker…']),
      ...column(960, 0, 'Done', 300, 600, G, ['Done…']),
    ],
  },
  {
    id: 'tpl-kanban', name: 'Kanban', background: 'dots', builtin: true,
    items: [
      { ...text(0, -80, 'Kanban: <project>', 40), bold: true },
      ...kanbanColumn(0, 'Backlog', V, ['Idea…', 'Idea…'], 1),
      ...kanbanColumn(320, 'To do', Y, ['Task…', 'Task…'], 2),
      ...kanbanColumn(640, 'Doing', B, ['Task…'], 3),
      ...kanbanColumn(960, 'Done ✓', G, ['Done…'], 4),
      text(0, 780, 'Columns are locked – drag the notes between them. Long-press a column (or ⋯ › Unlock all) to change it.', 18, '#6b7076'),
    ],
  },
  {
    id: 'tpl-weekly-review', name: 'Weekly Review', background: 'grid', builtin: true,
    items: [
      text(0, -110, 'Weekly Review – {{date}}', 40),
      text(0, -60, 'Energy: ☐☐☐☐☐   Focus: ☐☐☐☐☐', 22),
      ...column(0, 0, 'Wins 🎉', 300, 420, G, ['…', '…']),
      ...column(320, 0, 'Challenges', 300, 420, P, ['…', '…']),
      ...column(640, 0, 'Learnings', 300, 420, B, ['…', '…']),
      ...column(960, 0, 'Next week: top 3', 300, 600, Y, ['1.', '2.', '3.']),
      ...column(0, 450, 'Habits / health', 620, 150, O, []),
      text(660, 470, 'Notes for future me…', 22),
    ],
  },
];
