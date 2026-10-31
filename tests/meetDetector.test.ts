// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { parseMeetCode, readDomSignals } from '@/content/meetDetector';

describe('parseMeetCode', () => {
  it('extracts standard meeting codes', () => {
    expect(parseMeetCode('/abc-defg-hij')).toBe('abc-defg-hij');
    expect(parseMeetCode('/abc-defg-hij/')).toBe('abc-defg-hij');
  });
  it('handles account-switcher, embedded and 1:1 call URLs', () => {
    expect(parseMeetCode('/u/1/abc-defg-hij')).toBe('abc-defg-hij');
    expect(parseMeetCode('/_meet/abc-defg-hij')).toBe('abc-defg-hij');
    expect(parseMeetCode('/call/AbCd1234')).toBe('AbCd1234');
  });
  it('accepts nickname rooms but not site pages', () => {
    expect(parseMeetCode('/my-team-room')).toBe('my-team-room');
    expect(parseMeetCode('/landing')).toBeNull();
    expect(parseMeetCode('/new')).toBeNull();
    expect(parseMeetCode('/')).toBeNull();
    expect(parseMeetCode('/lookup/abc')).toBeNull();
  });
});

describe('readDomSignals', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds the leave control by aria-label', () => {
    document.body.innerHTML = '<button aria-label="Leave call"></button>';
    expect(readDomSignals(document).leaveControl).toBe(true);
  });

  it('finds the leave control by icon ligature when labels are localised', () => {
    document.body.innerHTML = '<button aria-label="Anruf verlassen"><i class="google-material-icons">call_end</i></button>';
    expect(readDomSignals(document).leaveControl).toBe(true);
  });

  it('does not report a leave control on the pre-join screen', () => {
    document.body.innerHTML = '<button><span>Join now</span></button><button aria-label="Turn off microphone"></button>';
    const s = readDomSignals(document);
    expect(s.leaveControl).toBe(false);
    expect(s.joinButton).toBe(true);
  });

  it('detects waiting-room text', () => {
    document.body.innerHTML = '<h1>Asking to be let in…</h1><button>Cancel</button>';
    expect(readDomSignals(document).waitingText).toBe(true);
  });
});
