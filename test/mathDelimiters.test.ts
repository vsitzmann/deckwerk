import { describe, expect, it } from 'vitest';
import { parseDeck, type Slide } from '../src/shared/deck.js';
import { mathTagCollisions, mathWarnings, unclosedMath } from '../src/shared/mathDelimiters.js';

/**
 * Bug #24: `y_{<k}` inside `$$…$$` in an authoring page is an HTML tag start
 * to the parser, so everything after it vanished and the slide showed a raw,
 * cut-off formula — and neither `apply` nor `validate` said a word.
 */

const text = (id: string, html: string) => ({
  id, type: 'text' as const, x: 0, y: 0, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
  class: [], style: {}, html, align: 'left' as const, valign: 'top' as const,
});

function slideOf(id: string, elements: unknown[]): Slide {
  return parseDeck({ version: 1, slides: [{ id, name: id, elements }] }).slides[0];
}

describe('unclosed maths in a text element', () => {
  it('finds a $$ the parser cut short, and a $ likewise', () => {
    expect(unclosedMath('$$\\big\\langle R_\\theta(x), p(y_k\\mid y_{')).toMatchObject({ delimiter: '$$' });
    expect(unclosedMath('<p>where $x_{</p>')).toMatchObject({ delimiter: '$' });
    expect(unclosedMath('$$\\big\\langle R_\\theta(x)')!.excerpt).toContain('\\big\\langle');
  });

  it('pairs delimiters the way the player renders them', () => {
    expect(unclosedMath('$$a_{1}$$ and $b^2$, then $$\\frac{1}{2}$$')).toBeNull();
    // A dollar inside braces does not close the maths, exactly as in KaTeX.
    expect(unclosedMath('$\\text{costs \\$5}$')).toBeNull();
    // Maths does not run across a tag: each text run renders on its own.
    expect(unclosedMath('<b>$x_{1}</b>$')).not.toBeNull();
    expect(unclosedMath('$x_1$ <b>bold</b> $y_2$')).toBeNull();
  });

  it('stays quiet about dollars in prose, escaped dollars and code', () => {
    expect(unclosedMath('It costs $5 a month')).toBeNull();
    expect(unclosedMath('Escaped \\$x_{1} is literal')).toBeNull();
    expect(unclosedMath('<code>echo $PATH_{x}</code>')).toBeNull();
    expect(unclosedMath('a &lt; b and y_{&lt;k}')).toBeNull();
  });
});

describe('a < inside maths in the page source', () => {
  it('finds y_{<k} and names its slide', () => {
    const source = `<section class="slide" data-slide-id="s1"><p>ok $a$</p></section>
<section class="slide" data-slide-id="s2"><p>$$p(y_k\\mid y_{<k})$$</p></section>`;
    const found = mathTagCollisions(source);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ slideId: 's2' });
    expect(found[0].excerpt).toContain('y_{<k}');
  });

  it('finds $a<b$ but not prose, escaped maths, or tags beside maths', () => {
    expect(mathTagCollisions('<p>$a<b$ holds</p>')).toHaveLength(1);
    expect(mathTagCollisions('<p>$y_{&lt;k}$ and $y_{\\lt k}$ and $a < b$</p>')).toEqual([]);
    expect(mathTagCollisions('<p>It costs $5 <b>a month</b></p>')).toEqual([]);
    expect(mathTagCollisions('<p>$x$ <span>then</span> $y$</p>')).toEqual([]);
    // The KaTeX bundle an exported page carries is full of `$` and `<`.
    expect(mathTagCollisions('<script>var a="$"; if (a<b) x()</script><style>p{}</style><p>fine</p>')).toEqual([]);
  });
});

describe('the warnings apply and validate report', () => {
  it('names the slide and the element, and says how to write the <', () => {
    const slides = [slideOf('repr', [text('eq', '$$\\big\\langle R_\\theta(x), p(y_k\\mid y_{')])];
    const source = '<section class="slide" data-slide-id="repr"><p>$$\\big\\langle R_\\theta(x), p(y_k\\mid y_{<k}) \\big\\rangle$$</p></section>';
    const warnings = mathWarnings(slides, source);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/slide repr/);
    expect(warnings[0]).toMatch(/element eq/);
    expect(warnings[0]).toContain('y_{<k}');
    expect(warnings[0]).toMatch(/&lt;.*\\lt/);
  });

  it('reports unbalanced maths with no page source, and nothing on sound maths', () => {
    const warnings = mathWarnings([slideOf('s', [text('a', '$x_{1}$'), text('b', 'see $\\alpha_{')])]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/slide s.*element b/);
    expect(mathWarnings([slideOf('s', [text('a', '$x_{1}$ and $$y^2$$')])], '<p>$x_{1}$</p>')).toEqual([]);
  });
});
