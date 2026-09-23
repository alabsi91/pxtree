import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createSession, type Session } from 'pxtree';

import { findLine, formatFixture } from './helpers.ts';

let session: Session;

before(async () => {
  session = await createSession();
});

after(async () => {
  await session.close();
});

function getFindingsPart(line: string): string {
  const findingsStart = line.indexOf('[!!');

  return findingsStart < 0 ? '' : line.slice(findingsStart);
}

describe('off-center.html', () => {
  let reportLines: string[];

  before(async () => {
    reportLines = await formatFixture(session, 'off-center');
  });

  test('icon button with an off-center icon', () => {
    assert.match(findLine(reportLines, 'button.icon-button'), /\[!! off center 3 up\]/);
  });

  test('link with low text', () => {
    assert.match(findLine(reportLines, 'a.low-text'), /text off center \d+ down/);
  });

  test('centered button and asymmetric card do not fire', () => {
    assert.equal(getFindingsPart(findLine(reportLines, 'button.centered-button')), '');
    assert.equal(getFindingsPart(findLine(reportLines, 'div.card')), '');
  });

  test('card whose first and last child keep default margins measures the ink, not the margins', () => {
    assert.match(findLine(reportLines, 'div.margin-card'), /\[!! off center \d+ down\]/);
  });
});

describe('truncation.html', () => {
  let reportLines: string[];

  before(async () => {
    reportLines = await formatFixture(session, 'truncation');
  });

  test('ellipsis, clamp and cut', () => {
    assert.match(findLine(reportLines, 'p.ellipsis'), /text truncated ellipsis \d+/);
    assert.match(findLine(reportLines, 'p.clamp'), /\[text \d+\/\d+, 2 lines\].*text clamped 2 lines/);
    assert.match(findLine(reportLines, 'p.cut'), /text cut \d+/);
  });

  test('truncated text does not also report text overflows', () => {
    assert.doesNotMatch(findLine(reportLines, 'p.ellipsis'), /text overflows/);
    assert.doesNotMatch(findLine(reportLines, 'p.cut'), /text overflows/);
  });

  test('text overflowing its box', () => {
    assert.match(findLine(reportLines, 'p.spill'), /text overflows end \d+/);
  });

  test('span clipped by the card', () => {
    const noteLine = findLine(reportLines, 'span.note');

    assert.match(noteLine, /clipped right \d+ by div\.card/);
    assert.doesNotMatch(noteLine, /overflows parent/);
  });

  test('full-bleed section prints its equal overhang as one finding', () => {
    assert.match(findLine(reportLines, 'section.bleed'), /\[!! overflows parent start and end 340\]/);
  });

  test('past the viewport, a box that sticks out of its own wide parent fires as well as the parent', () => {
    assert.match(findLine(reportLines, 'div.wide-row'), /\[!! past viewport end 60\]/);
    assert.match(findLine(reportLines, 'div.wider-child'), /\[!! past viewport end 160\]/);
    assert.doesNotMatch(findLine(reportLines, 'div.wider-child'), /overflows parent/);
  });
});

describe('alignment.html', () => {
  let reportLines: string[];

  before(async () => {
    reportLines = await formatFixture(session, 'alignment');
  });

  test('card row whose buttons sit at different heights', () => {
    const cardsLine = findLine(reportLines, 'ul.cards');

    assert.match(cardsLine, /a\.button tops \d+\.\.\d+ across siblings/);
    assert.doesNotMatch(cardsLine, /\bp tops/);
  });

  test('one wider card', () => {
    const planLines = reportLines.filter((line) => line.trimStart().startsWith('li.plan'));

    assert.equal(planLines.filter((line) => line.includes('12 wider than li.plan')).length, 1, reportLines.join('\n'));
    assert.match(findLine(reportLines, 'li.plan.featured'), /12 wider than li\.plan\]/);
  });

  test('unequal list gaps, with a state class on the odd step', () => {
    assert.match(findLine(reportLines, 'ul.steps'), /\[!! gaps 16 16 24 16 between li\.step\]/);
  });

  test('a stat card with a state class pushed down in its row', () => {
    assert.match(findLine(reportLines, 'div.stats'), /\[!! div\.stat tops 0\.\.6 across siblings\]/);
  });

  test('heading and paragraph stack does not fire', () => {
    assert.equal(getFindingsPart(findLine(reportLines, 'article')), '');
    assert.ok(!reportLines.some((line) => line.trimStart().startsWith('h2') && line.includes('[!!')), reportLines.join('\n'));
  });

  test('a paragraph with an inline link is a text flow without gaps', () => {
    assert.doesNotMatch(findLine(reportLines, 'p.with-link'), /\[gaps/);
  });

  test('buttons with padded text do not report text off center', () => {
    assert.ok(!reportLines.some((line) => line.includes('text off center')), reportLines.join('\n'));
  });
});

describe('overlaps.html', () => {
  let reportLines: string[];

  before(async () => {
    reportLines = await formatFixture(session, 'overlaps');
  });

  test('caption pulled over the photo by a negative margin', () => {
    assert.match(findLine(reportLines, 'div.caption'), /overlaps div\.photo 300x20/);
  });

  test('absolute badge colliding with a card', () => {
    assert.match(findLine(reportLines, 'span.badge'), /overlaps div\.card\.second-card 20x40/);
  });

  test('each avatar in a stack reports its overlap with the previous one', () => {
    const avatarLines = reportLines.filter((line) => line.includes('overlaps span.avatar'));

    assert.ok(avatarLines.length > 0, reportLines.join('\n'));
  });

  test('fixed element and inline span do not fire', () => {
    assert.ok(!reportLines.some((line) => line.includes('overlaps div.box')), reportLines.join('\n'));
  });

  test('a covered pair does not repeat as overlaps', () => {
    assert.match(findLine(reportLines, 'p "Note text'), /covered bottom \d+ by div\.cover/);
    assert.doesNotMatch(findLine(reportLines, 'div.cover'), /overlaps/);
  });
});

describe('images.html', () => {
  let reportLines: string[];

  before(async () => {
    reportLines = await formatFixture(session, 'images');
  });

  test('images that did not load, are stretched or upscaled', () => {
    assert.match(findLine(reportLines, 'img.broken'), /image not loaded/);
    assert.match(findLine(reportLines, 'img.stretched'), /image aspect 0\.50 of natural/);
    assert.match(findLine(reportLines, 'img.upscaled'), /image upscaled 2\.0/);
  });

  test('vector image and stretched downscale do not report upscaled', () => {
    assert.doesNotMatch(findLine(reportLines, 'img.vector'), /upscaled/);
    assert.doesNotMatch(findLine(reportLines, 'img.stretched'), /upscaled/);
    assert.doesNotMatch(findLine(reportLines, 'img.upscaled'), /image aspect/);
  });

  test('small icon link next to another one', () => {
    assert.match(findLine(reportLines, 'a.icon-link'), /small target 16x16/);
  });

  test('a small icon link with room around it passes by spacing', () => {
    assert.doesNotMatch(findLine(reportLines, 'a.spaced-link'), /small target/);
  });

  test('inline link in text does not fire', () => {
    assert.doesNotMatch(findLine(reportLines, 'a "docs"'), /small target/);
  });

  test('checkbox and radio with a big label do not fire, with a tiny label they do', () => {
    assert.doesNotMatch(findLine(reportLines, 'input.agree'), /small target/);
    assert.doesNotMatch(findLine(reportLines, 'input#plan-a'), /small target/);
    assert.match(findLine(reportLines, 'input.tiny'), /small target 13x13/);
  });
});

describe('by-design.html', () => {
  let reportLines: string[];

  before(async () => {
    reportLines = await formatFixture(session, 'by-design');
  });

  test('a marquee prints its clipped items with the role and animation facts', () => {
    assert.match(findLine(reportLines, 'section.marquee '), /\[role marquee\]\[clips 1 of 1 children\]/);
    assert.match(findLine(reportLines, 'div.marquee-track '), /\[animating\]/);
    assert.ok(reportLines.includes('  clipped out by section.marquee ×4: div.marquee-track span'), reportLines.join('\n'));
    assert.match(findLine(reportLines, 'span "Umbrella"'), /\[!! clipped right \d+ by section\.marquee\]/);
  });

  test('a translated carousel track prints its hidden slides and the visible slide that overflows the track', () => {
    assert.match(findLine(reportLines, 'section.carousel '), /\[role carousel\]/);
    assert.match(findLine(reportLines, 'ul.carousel-track '), /\[translated x -320\]\[clipped out by div\.carousel-viewport\]/);
    assert.ok(reportLines.includes('  clipped out by div.carousel-viewport ×4: li.slide'), reportLines.join('\n'));
    assert.doesNotMatch(findLine(reportLines, 'li.slide "Slide two"'), /clipped/);
    assert.ok(!reportLines.some((line) => line.includes('past viewport')), reportLines.join('\n'));
  });

  test('a slide with an absolute caption counts only its own text lines', () => {
    assert.match(findLine(reportLines, 'li.slide "Slide three"'), /\[text 16\/24\]/);
  });

  test('an absolute dropdown whose containing block is inside an overflow hidden header is clipped by it', () => {
    assert.ok(reportLines.includes('  clipped out by header.rounded-header: div.dropdown'), reportLines.join('\n'));
  });

  test('an absolute box escapes an overflow hidden box between it and its containing block', () => {
    assert.doesNotMatch(findLine(reportLines, 'span.escaping-label '), /clipped/);
    assert.doesNotMatch(findLine(reportLines, 'div.mask '), /\[clips/);
  });

  test('a scroll-snap carousel is a scroll container and prints no clipping', () => {
    assert.match(findLine(reportLines, 'section.snap-carousel '), /\[scroll x 960 in 320, 2 of 3 out\]/);
    assert.doesNotMatch(findLine(reportLines, 'div.snap-slide '), /\[!!/);
  });

  test('a zoomed image clipped by its card prints the facts and no finding', () => {
    assert.match(findLine(reportLines, 'section.zoom-card '), /\[clips 1 of 2 children\]/);
    assert.match(findLine(reportLines, 'img '), /\[scaled 1\.15 from 200x120\]/);
    assert.doesNotMatch(findLine(reportLines, 'img '), /\[!!/);
  });

  test('a fixed-height panel cutting its paragraph and button still fires', () => {
    assert.match(findLine(reportLines, 'p "This panel has a…"'), /\[!! clipped bottom \d+ by section\.panel\]/);
    assert.match(findLine(reportLines, 'button.submit '), /\[!! clipped out by section\.panel\]/);
  });
});
