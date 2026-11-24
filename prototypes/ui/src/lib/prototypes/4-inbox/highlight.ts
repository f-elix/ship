/** A deliberately tiny highlighter: enough colour to read an excerpt, no grammar. */
export type Token = { text: string; kind: 'kw' | 'str' | 'com' | 'num' | 'fn' | 'plain' };

const KEYWORDS = new Set(
	'const let var function return if else export import from as await yield new type interface pub fn use mod struct enum impl match mut true false null undefined BEGIN COMMIT ALTER TABLE ADD COLUMN NOT NULL UPDATE SET FROM WHERE it describe expect'.split(
		' '
	)
);

const RE = /(\/\/.*$|--.*$|\/\/!.*$|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w]*)(?=\s*\()|([A-Za-z_][\w]*)|(\s+|.)/gm;

export const tokenize = (line: string): Token[] => {
	const out: Token[] = [];
	for (const m of line.matchAll(RE)) {
		const [text, strOrCom, num, fn, word] = m;
		if (strOrCom) out.push({ text, kind: strOrCom.startsWith('//') || strOrCom.startsWith('--') ? 'com' : 'str' });
		else if (num) out.push({ text, kind: 'num' });
		else if (fn) out.push({ text, kind: KEYWORDS.has(fn) ? 'kw' : 'fn' });
		else if (word) out.push({ text, kind: KEYWORDS.has(word) ? 'kw' : 'plain' });
		else {
			const last = out.at(-1);
			if (last?.kind === 'plain') last.text += text;
			else out.push({ text, kind: 'plain' });
		}
	}
	return out;
};
