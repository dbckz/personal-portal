import type { AsanaStory, PlannerTask } from './types';

function compactStories(stories: AsanaStory[]): string {
  return stories
    .filter(story => story?.text)
    .slice(-8)
    .map(story => `- ${story.createdAt || 'unknown'} | ${story.createdBy?.name || 'unknown'} | ${story.text}`)
    .join('\n');
}

function baseTaskBlock(task: PlannerTask, stories: AsanaStory[], brief: string): string {
  return [
    `Task title: ${task.title}`,
    `Task id: ${task.id}`,
    `Integration: ${task.integrationName || 'unknown'}`,
    `Due on: ${task.dueOn || 'none'}`,
    `Description:\n${task.description || '(none)'}`,
    `Your brief:\n${brief}`,
    stories.length ? `Recent stories/comments:\n${compactStories(stories)}` : 'Recent stories/comments: (none)',
  ].join('\n\n');
}

interface BriefPromptInput {
  task: PlannerTask;
  stories: AsanaStory[];
  brief: string;
}

// The brief is a plain-English instruction composed at delegate time. A brief
// that starts with a `~name` token is treated as "use your <name> skill" (the
// user's Claude Code skills are available to the runner via the Skill tool).
export function buildBriefPrompt({ task, stories, brief }: BriefPromptInput): string {
  const trimmed = brief.trim();
  const skillMatch = trimmed.match(/^~([A-Za-z0-9_-]+)\b/);
  const lead = skillMatch
    ? [`Use your ${skillMatch[1]} skill for this task, following it exactly.`, 'Then carry out the brief below and do the actual work now.']
    : ['Carry out the following brief as a bounded task.', 'Do the work now using available tools as needed.'];

  return [
    ...lead,
    'To read an Asana task in EITHER Dave\'s DBC or OM workspace, prefer the '
      + 'calendar-asana MCP tool get_task — it uses the app\'s own stored '
      + 'integrations and works in both workspaces, unlike the Asana connector '
      + 'which only covers OM.',
    'NEVER post a comment to Asana yourself (do not use the Asana connector or '
      + 'any other tool to add a comment or story). If you want to leave a '
      + 'comment on a task, use the calendar-asana draft_comment tool — it saves '
      + 'the comment as a local draft for Dave to review, edit and post himself. '
      + 'It does NOT post to Asana.',
    'When you create a Gmail REPLY draft (create_draft on an existing thread), '
      + 'the API does NOT add the quoted conversation below your text the way '
      + 'the Gmail compose window does — a draft sent as-is loses the thread '
      + 'history, so anyone later added to the thread has no context. You MUST '
      + 'therefore fetch the thread (get_thread) and append the full quoted '
      + 'trail below your reply: a blank line, then '
      + '"On <date>, <sender name> <<email>> wrote:" followed by the prior '
      + 'message with each line prefixed by "> " (and earlier messages nested '
      + 'with ">> ", etc., or included via the previous message\'s own quoted '
      + 'trail). New standalone emails (no thread) need no quoting.',
    'Return ONLY valid JSON with this schema:',
    '{"status":"successful|failed","summary":"string","outputs":["string"],"next":"string"}',
    'outputs should be a short list of concrete review items such as URLs, artefacts produced, or key caveats.',
    'Do not include markdown fences or extra commentary.',
    'If information is missing, set status to failed and explain the blocker in summary/next.',
    '',
    baseTaskBlock(task, stories, trimmed),
  ].join('\n');
}
