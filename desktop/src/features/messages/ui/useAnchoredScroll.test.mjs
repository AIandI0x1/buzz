import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SETTLE_QUIET_FRAMES,
  observeScrollSettle,
  settleProgrammaticBottomPin,
} from "./useAnchoredScroll.ts";

function fakeContainer({ clientHeight, scrollHeight, scrollTop }) {
  const writes = [];
  return {
    clientHeight,
    scrollHeight,
    scrollTop,
    writes,
    scrollTo({ top, behavior }) {
      writes.push({ top, behavior });
      this.scrollTop = top;
    },
  };
}

test("settleProgrammaticBottomPin chases the physical floor before clearing", () => {
  const container = fakeContainer({
    clientHeight: 100,
    scrollHeight: 200,
    scrollTop: 70,
  });

  assert.equal(settleProgrammaticBottomPin(container), true);
  assert.deepEqual(container.writes, [{ top: 200, behavior: "auto" }]);
  assert.equal(container.scrollTop, 200);
});

test("settleProgrammaticBottomPin keeps settling when the floor is still out of reach", () => {
  const container = fakeContainer({
    clientHeight: 100,
    scrollHeight: 200,
    scrollTop: 70,
  });
  container.scrollTo = ({ top, behavior }) => {
    container.writes.push({ top, behavior });
    // Browser/virtualizer has not caught up yet: leave a >1px physical gap.
    container.scrollTop = 98;
  };

  assert.equal(settleProgrammaticBottomPin(container), false);
  assert.deepEqual(container.writes, [{ top: 200, behavior: "auto" }]);
  assert.equal(
    container.scrollHeight - container.clientHeight - container.scrollTop,
    2,
  );
});

// ---------------------------------------------------------------------------
// observeScrollSettle — the polled quiet-window detector at the heart of the
// settle gate. A manual frame driver replaces requestAnimationFrame so each
// tick can read a scripted scrollTop, making the WebKit coalesced-freeze case
// (design edge #1) directly testable.
// ---------------------------------------------------------------------------

/**
 * Drive `observeScrollSettle` frame-by-frame. `positions` is the scrollTop the
 * container reports on each successive tick. Returns { settledAt } — the
 * 1-based frame index at which onSettle fired, or null if it never did within
 * the scripted frames.
 */
function runSettle(positions, quietFrames) {
  const queue = [];
  const scheduleFrame = (cb) => {
    queue.push(cb);
    return queue.length; // non-zero id
  };
  const cancelled = new Set();
  const cancelFrame = (id) => cancelled.add(id);

  let frame = 0;
  const container = {
    get scrollTop() {
      // Position seen on the tick about to run. Clamp to the last scripted
      // value so a still tail keeps reporting the final resting position.
      return positions[Math.min(frame, positions.length - 1)];
    },
  };

  let settledAt = null;
  const cancel = observeScrollSettle(
    container,
    quietFrames,
    () => {
      settledAt = frame;
    },
    scheduleFrame,
    cancelFrame,
  );

  // Pump queued frames until the loop stops scheduling or we exhaust the script.
  while (queue.length > 0 && frame < positions.length + quietFrames + 2) {
    const cb = queue.shift();
    frame += 1;
    cb();
  }
  return { settledAt, cancel };
}

test("observeScrollSettle fires only after k consecutive still frames", () => {
  // Baseline top is 100 (captured at arm time). Frames all report 100 → still
  // from frame 1. With k=3, settle fires on the 3rd consecutive still frame.
  const { settledAt } = runSettle([100, 100, 100, 100], 3);
  assert.equal(settledAt, 3);
});

test("observeScrollSettle does not settle during the WebKit coalesced freeze", () => {
  // Design edge #1: WebKit freezes scrollTop reads for ~2 frames mid-fling,
  // then momentum resumes. A gate that fired on 2 still frames would re-anchor
  // here — mid-fling — recreating the walk-blind jump. Baseline 100, frozen at
  // 100 for two frames, then the fling resumes (120, 140), then truly rests.
  const positions = [100, 100, 120, 140, 160, 160, 160, 160];
  const { settledAt } = runSettle(positions, DEFAULT_SETTLE_QUIET_FRAMES);
  // Must NOT have fired during the 2-frame freeze (frames 1–2).
  assert.ok(
    settledAt === null || settledAt > 2,
    `settled at frame ${settledAt}; expected to survive the 2-frame freeze`,
  );
  // It should settle only once truly at rest at 160 (frames 5–8: three stills
  // after the last move land the settle on frame 7).
  assert.equal(settledAt, 7);
});

test("observeScrollSettle resets the counter when movement resumes", () => {
  // One still frame, then a move, then a genuine rest. The lone still frame
  // must not count toward the final quiet window.
  const { settledAt } = runSettle([100, 100, 130, 130, 130, 130], 3);
  // First still frame is at pos[1]; the move to 130 at pos[2] resets the
  // counter. Three stills follow (pos[3..5]) → settle on frame 5, proving the
  // lone earlier still did not carry over.
  assert.equal(settledAt, 5);
});

test("observeScrollSettle cancel stops the loop and never fires onSettle", () => {
  const queue = [];
  const scheduleFrame = (cb) => {
    queue.push(cb);
    return queue.length;
  };
  const cancelled = [];
  const container = { scrollTop: 100 };
  let fired = false;
  const cancel = observeScrollSettle(
    container,
    3,
    () => {
      fired = true;
    },
    scheduleFrame,
    (id) => cancelled.push(id),
  );
  // Run one still frame (counter = 1), then cancel before it can reach k.
  queue.shift()();
  cancel();
  // Any queued frame must be cancelled; draining it must be a no-op.
  while (queue.length > 0) queue.shift()();
  assert.equal(fired, false);
  assert.ok(cancelled.length >= 1);
});

test("observeScrollSettle clamps sub-minimum quietFrames up to the default", () => {
  // A caller passing quietFrames=1 would settle on the first still frame and
  // read the freeze as a settle. The clamp forces the freeze-clearing minimum.
  const { settledAt } = runSettle([100, 100, 100, 100], 1);
  assert.equal(settledAt, DEFAULT_SETTLE_QUIET_FRAMES);
});
