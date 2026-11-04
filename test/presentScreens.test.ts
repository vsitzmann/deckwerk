import { describe, expect, it } from 'vitest';
import {
  audienceWindowFeatures,
  chooseScreens,
  decideAfterScreenDetails,
  mayUseSecondScreen,
  planForPermission,
  speakerWindowFeatures,
  type ScreenArea,
} from '../src/renderer/collab/presentScreens.js';

/**
 * Which screen a browser presentation goes on, decided the way the desktop
 * app decides it (src/main/presentationDisplays.ts): the audience on a screen
 * of its own, Speaker View on the presenter's.
 */

function screen(label: string, left: number, extra: Partial<ScreenArea> = {}): ScreenArea & { label: string } {
  return {
    label,
    left,
    top: 0,
    width: 1512,
    height: 982,
    availLeft: left,
    availTop: 25,
    availWidth: 1512,
    availHeight: 957,
    ...extra,
  };
}

const laptop = screen('Built-in Retina Display', 0, { isInternal: true });
const projector = screen('Projector', 1512, { isInternal: false });
const monitor = screen('Studio Display', -1512, { isInternal: false });

describe('whether Present looks for a second screen', () => {
  it('needs both the API and more than one screen', () => {
    expect(mayUseSecondScreen({ hasApi: true, isExtended: true })).toBe(true);
    expect(mayUseSecondScreen({ hasApi: true, isExtended: false })).toBe(false);
    // Safari and Firefox: no Window Management API at all.
    expect(mayUseSecondScreen({ hasApi: false, isExtended: undefined })).toBe(false);
    expect(mayUseSecondScreen({ hasApi: false, isExtended: true })).toBe(false);
  });

  it('presents on two screens when allowed, asks when not yet, and never nags after a refusal', () => {
    expect(planForPermission('granted')).toBe('two-screens');
    expect(planForPermission('prompt')).toBe('ask');
    // A browser that cannot say (an older permission name) is asked: the
    // prompt itself is the only way to find out.
    expect(planForPermission('unknown')).toBe('ask');
    expect(planForPermission('denied')).toBe('this-screen');
  });
});

describe('choosing the audience and Speaker View screens', () => {
  it('keeps Speaker View on the laptop and the audience on the projector, wherever the editor is', () => {
    expect(chooseScreens([laptop, projector], laptop)).toEqual({ audience: projector, speaker: laptop });
    // The editor window left on the projector used to swap them: the slides
    // on the laptop, Speaker View on the projector.
    expect(chooseScreens([projector, laptop], projector)).toEqual({ audience: projector, speaker: laptop });
  });

  it('puts the audience on the external screen the editor is not on when there are three', () => {
    expect(chooseScreens([laptop, monitor, projector], monitor)).toEqual({ audience: projector, speaker: laptop });
    expect(chooseScreens([laptop, projector, monitor], laptop)).toEqual({ audience: projector, speaker: laptop });
  });

  it('goes by the editor window when no screen says it is the laptop\'s', () => {
    const left = { ...monitor, isInternal: undefined };
    const right = { ...projector, isInternal: undefined };
    expect(chooseScreens([left, right], left)).toEqual({ audience: right, speaker: left });
    expect(chooseScreens([left, right], right)).toEqual({ audience: left, speaker: right });
  });

  it('has nothing to offer when only the editor screen is left', () => {
    expect(chooseScreens([laptop], laptop)).toBeNull();
    expect(chooseScreens([], laptop)).toBeNull();
  });

  it('recognises the editor screen by its position when it is a different object', () => {
    // ScreenDetails hands out live objects; a copy of the same screen must not
    // count as "another" screen and put the audience on top of the editor.
    expect(chooseScreens([laptop, projector], { ...laptop })).toEqual({ audience: projector, speaker: laptop });
  });
});

describe('placing Speaker View', () => {
  it('fills the available area of the editor screen', () => {
    expect(speakerWindowFeatures(laptop)).toBe('popup,left=0,top=25,width=1512,height=957');
    expect(speakerWindowFeatures(monitor)).toBe('popup,left=-1512,top=25,width=1512,height=957');
  });

  it('opens a one-screen audience as a 16:9 window of its own in the lower right, not a tab', () => {
    // 45% of 1512 is 680 wide, 383 high, flush with the bottom-right corner.
    expect(audienceWindowFeatures(laptop)).toBe('popup,left=832,top=599,width=680,height=383');
  });
});

describe('after asking for the screens', () => {
  const details = { screens: [laptop, projector], currentScreen: laptop };

  it('presents on two screens while the click still counts', () => {
    expect(decideAfterScreenDetails({ details, home: laptop, activationLive: true }))
      .toEqual({ kind: 'two-screens', audience: projector, speaker: laptop });
  });

  it('starts nothing once the click no longer counts, whatever the answer', () => {
    // Fullscreen and pop-ups both need a live click. A presenter who took a
    // while over the prompt gets a clean "press Present again", never a
    // half-started show that is neither fullscreen nor on the projector.
    expect(decideAfterScreenDetails({ details, home: laptop, activationLive: false }))
      .toEqual({ kind: 'present-again', allowed: true });
    expect(decideAfterScreenDetails({ details: null, home: null, activationLive: false }))
      .toEqual({ kind: 'present-again', allowed: false });
  });

  it('presents on this screen when refused, or when the second screen has gone', () => {
    expect(decideAfterScreenDetails({ details: null, home: null, activationLive: true }))
      .toEqual({ kind: 'this-screen' });
    expect(decideAfterScreenDetails({
      details: { screens: [laptop], currentScreen: laptop }, home: laptop, activationLive: true,
    })).toEqual({ kind: 'this-screen' });
  });
});
