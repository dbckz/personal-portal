import { getTask, draftComment } from '../asana-tools';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

describe('getTask', () => {
  it('formats the task returned by the app route', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({
        task: {
          name: 'Draft blog post',
          completed: false,
          due_on: '2026-08-01',
          assignee: { name: 'Dave' },
          permalink_url: 'https://app.asana.com/0/0/123',
          notes: 'Some notes',
        },
        integration: { name: 'DBC', workspaceName: 'Dave Buckley Consulting' },
      })
    );

    const text = await getTask('123', { baseUrl: 'http://x', fetchFn });

    expect(fetchFn).toHaveBeenCalledWith('http://x/api/orchestrator/asana/tasks/123');
    expect(text).toContain('Task: Draft blog post');
    expect(text).toContain('Workspace: Dave Buckley Consulting');
    expect(text).toContain('Due on: 2026-08-01');
    expect(text).toContain('Assignee: Dave');
    expect(text).toContain('URL: https://app.asana.com/0/0/123');
    expect(text).toContain('Some notes');
  });

  it('throws with the route error message on failure', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({ error: 'No enabled Asana integration can access task 999.' }, false, 404)
    );

    await expect(getTask('999', { baseUrl: 'http://x', fetchFn })).rejects.toThrow(
      /No enabled Asana integration can access task 999/
    );
  });

  it('rejects an empty gid without calling fetch', async () => {
    const fetchFn = jest.fn();
    await expect(getTask('   ', { baseUrl: 'http://x', fetchFn })).rejects.toThrow(/gid is required/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('draftComment', () => {
  it('saves the comment as a local draft via the draft-comment route', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({ draft: { id: 'd1', text: 'Looks good' } })
    );

    const result = await draftComment('456', 'Looks good', { baseUrl: 'http://x', fetchFn });

    expect(fetchFn).toHaveBeenCalledWith(
      'http://x/api/orchestrator/asana/tasks/456/draft-comment',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'Looks good' }),
      })
    );
    expect(result).toContain('LOCAL DRAFT');
    expect(result).toContain('456');
    expect(result).toContain('NOT posted to Asana');
  });

  it('requires non-empty text', async () => {
    const fetchFn = jest.fn();
    await expect(draftComment('456', '  ', { baseUrl: 'http://x', fetchFn })).rejects.toThrow(/text is required/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws the route error on failure', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, false, 500));
    await expect(draftComment('1', 'hi', { baseUrl: 'http://x', fetchFn })).rejects.toThrow(/boom/);
  });
});
