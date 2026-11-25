export function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

export async function research(_kind, input) {
  const query = typeof input === 'string' ? input.trim().slice(0, 180) : '';
  if (query.length < 2) throw problem(400, 'Enter at least two characters.');
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) throw problem(503, 'In-room web search needs a BRAVE_SEARCH_API_KEY configured on the server.');
  try {
    const params = new URLSearchParams({ q: query, count: '8', safesearch: 'strict', text_decorations: 'false' });
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Search provider returned ${response.status}.`);
    const data = await response.json();
    return (data.web?.results || []).map(result => ({
      title: typeof result.title === 'string' ? result.title : '',
      text: typeof result.description === 'string' ? result.description : '',
      url: typeof result.url === 'string' ? result.url : ''
    }));
  } catch (error) {
    if (error.status) throw error;
    console.error('Mauiza web search:', error.message);
    throw problem(502, 'Web search is temporarily unavailable. Try again in a moment.');
  }
}
