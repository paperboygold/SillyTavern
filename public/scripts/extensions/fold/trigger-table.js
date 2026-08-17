/**
 * fold/trigger-table.js — when to look, and when to adjudicate.
 *
 * Pure, imports only ./clock.js for nothing any more — the scene-probe answers replaced the
 * narrative time-reading. Unit-testable.
 *
 * ── Why a fixed interval was the wrong unit ──
 *
 * Extraction ran every N assistant turns. That measures the wrong thing entirely: **a turn is not a
 * quantity of change.** One reply can cross a continent, skip a year, end a siege and introduce six
 * people; the next can be two lines of dialogue in the same room. Scheduling by turn count treats
 * those identically, so a scene that moved on turn 21 stays wrong on the panel until turn 24 —
 * measured on a live chat, the location read "the hobgoblin's chamber" three turns after the party
 * had left it.
 *
 * The interval survives as a CEILING — a promise that state is never more than N turns stale — but
 * it stops being the schedule. What schedules extraction is evidence that something moved, which
 * fold can read out of the text for free.
 *
 * That evidence is deliberately cheap and deliberately over-eager. A false positive costs one
 * extraction that finds nothing; a false negative leaves the panel lying about where you are. The
 * two are not symmetric, so the gate is not balanced.
 *
 * ── Why the attempt gate is the opposite ──
 *
 * Adjudication BLOCKS the reply — it is a call the player waits on — and a wrong verdict is worse
 * than no verdict. So that gate is conservative where this one is eager: it wants an unmistakable
 * attempt at something contested, and lets ordinary conversation through untouched.
 */

/**
 * ── A verb-based movement gate was tried and DELETED ──
 *
 * The obvious design is to watch for travel language — "we head into the next chamber" — and look
 * again when it appears. It was built, and then measured against a real 47-message chat, and it
 * fired on 23 of 24 narrator messages and 13 of 23 player messages. Not because the patterns were
 * sloppy but because the words are simply not diagnostic in action prose: `head` is a body part,
 * `reaches` is what you do to a dagger, `goes down` is what a goblin does, and "the next" is far
 * more often "the next chamber" than "the next morning".
 *
 * A signal that fires on nearly every turn is not a signal — it is a shorter interval wearing a
 * heuristic's clothes, at four times the cost and with none of the honesty. So what remains here is
 * only what can be recognised precisely, and the adaptive interval below does the rest.
 */

/** A horizontal rule — the one scene-break marker that is pure punctuation, not vocabulary. */
const SCENE_BREAK = /^\s*[-*#=~_]{3,}\s*$/m;

/**
 * The two reasons a pass may run that mean *narrative time has moved*, named rather than spelled.
 *
 * They were string literals returned from `sceneMayHaveMoved` and consumed only by an observe
 * counter (`extract:on-time-skipped`), where a typo would have shown up as a counter nobody could
 * find. Phase W makes them load-bearing: they are what arms the world fragment
 * (FOLD-REDESIGN.md §7.4, "armed only when the pass was triggered by a time skip or scene break"),
 * and an armed fragment is the difference between the world moving and the world not. A reason
 * compared by literal in two files is a feature that stops working the day somebody rewords a log
 * line, silently and with no test able to see it — so the strings have one definition and
 * `world-table.js` imports it.
 *
 * The list is deliberately NOT "every reason": `interval` and `state block` are cadence, not time.
 * A conversational pass that happens to land on the ceiling has skipped nothing.
 *
 * ── Why only the horizontal rule, now ──
 *
 * `TIME_SKIPPED` and the English phrase half of `SCENE_BREAK` read the narrative with word lists
 * ("come morning", "hours later") that only work in English. Time passage is the scene probe's
 * comprehension question (`elapsed_days`/`elapsed_minutes`/`date_changed`), so the cadence gate no
 * longer guesses it from prose — the interval catches a quiet skip, and the model reports a loud
 * one. `WORLD_TRIGGERS` still names both reasons so an armed pass can be attributed, but the
 * trigger that fires them is now the model's own report, not a regex.
 *
 * ── That last sentence was true of the deletion and false of the wiring, for a while ──
 *
 * Removing the word lists left `TIME_SKIPPED` with no producer at all: nothing anywhere emitted it,
 * so `world.js` armed on a reason that could not occur and the off-screen world never wrote a single
 * event. Measured across every live campaign before the repair: `0` events with `src: 'world'`,
 * against 566 `world:idle` counters. The docblock described the intended design and nothing
 * implemented it, which is the failure mode a comment is least able to catch.
 *
 * The producer now exists: `state.js` `applyClock` raises a flag when the scene probe's reported
 * elapse is accepted, and `index.js` reads-and-clears it to escalate the next pass's `why` to
 * `TIME_SKIPPED`. The report is still the model's; only the wire is fold's.
 */
export const TIME_SKIPPED = 'time skipped';
export const SCENE_BREAK_WHY = 'scene break';
export const WORLD_TRIGGERS = Object.freeze([TIME_SKIPPED, SCENE_BREAK_WHY]);

/**
 * Has the scene demonstrably moved?
 *
 * Only claims a move when the text's SHAPE says so — a horizontal rule, which is punctuation and
 * means the same thing in every language. Everything else (time skips, scene transitions) is left
 * to the interval or the scene probe's own report, which is the model's comprehension answer.
 *
 * @param {string} text The latest narrative.
 * @returns {{moved: boolean, why: string}} Whether to look, and what said so.
 */
export function sceneMayHaveMoved(text) {
    const said = String(text ?? '');
    if (!said.trim()) {
        return { moved: false, why: '' };
    }
    if (SCENE_BREAK.test(said)) {
        return { moved: true, why: SCENE_BREAK_WHY };
    }
    return { moved: false, why: '' };
}

/**
 * How long to wait before looking again.
 *
 * ── Let the answer set the question ──
 *
 * The interval was fixed, and a fixed cadence measures the wrong thing: a turn is not a quantity of
 * change. But the heuristics that tried to detect change from the text were noise, so the reliable
 * evidence turns out to be the extraction's OWN result. If the last look found the scene had moved,
 * look again soon; if it found nothing had changed, wait longer.
 *
 * That is self-tuning, needs no keyword lists, and optimises exactly the thing that matters —
 * frequent checks while the story is moving, rare ones while it sits in a room talking. It also
 * degrades safely in both directions: the floor bounds staleness, the ceiling bounds cost.
 *
 * @param {object} params Parameters.
 * @param {number} params.current The interval last used.
 * @param {boolean} params.changed Whether the last extraction found the scene had moved.
 * @param {number} [params.min] Floor.
 * @param {number} [params.max] Ceiling.
 * @returns {number} The next interval.
 */
export function nextInterval({ current, changed, min = MIN_INTERVAL, max = MAX_INTERVAL }) {
    const now = Number.isFinite(current) ? current : min;
    if (changed) {
        return min;
    }
    // Additive backoff rather than doubling: a scene that has been quiet for a while is not
    // exponentially more likely to stay quiet, and doubling reaches the ceiling in two steps,
    // which throws away the resolution this exists to provide.
    return Math.max(min, Math.min(max, now + 1));
}

/** Bounds on the adaptive interval: how stale state may get, and how often it may cost a call. */
export const MIN_INTERVAL = 2;
export const MAX_INTERVAL = 8;

/**
 * Should extraction run now?
 *
 * @param {object} params Parameters.
 * @param {number} params.since Assistant turns since extraction last ran.
 * @param {number} params.interval The current adaptive interval.
 * @param {string} [params.text] The latest exchange, for a declared time skip.
 * @param {boolean} [params.block] Whether a state block just arrived.
 * @returns {{run: boolean, why: string}} The decision and its reason.
 */
export function shouldExtract({ since, interval, text = '', block = false }) {
    const turns = Number.isFinite(since) ? since : 0;
    const ceiling = Math.max(1, Number(interval) || MIN_INTERVAL);

    // Never twice for the same turn.
    if (turns < 1) {
        return { run: false, why: 'already current' };
    }
    if (turns >= ceiling) {
        return { run: true, why: 'interval' };
    }
    // A narrator that restates its whole block has handed over a new scene; read it now.
    if (block) {
        return { run: true, why: 'state block' };
    }
    const moved = sceneMayHaveMoved(text);
    return moved.moved ? { run: true, why: moved.why } : { run: false, why: 'waiting' };
}

/**
 * ── An English verb list was tried and DELETED ──
 *
 * The gate was a list of contested verbs — attack, climb, persuade, sneak — matched against the
 * player's message. It failed twice over.
 *
 * It failed on precision: measured against a real chat it ran about 50%, calling "I give a shrug,
 * 'my main work is IT and cybersecurity'" a contested attempt.
 *
 * And it failed on a more basic point. **SillyTavern is not an English program.** A Chinese, Korean
 * or Russian player writes their attempt in their own language, matches nothing, and adjudication
 * silently never fires for them — a whole feature that works for some users and is invisible to
 * others, with nothing anywhere saying so. A word list is not a small approximation of language
 * understanding; it is a different thing that happens to work on one language.
 *
 * The distinction that matters, and that this codebase now holds to:
 *
 *   · fold's own vocabulary — category names, enum values, the outcome bands — may be English.
 *     Those are a PROTOCOL between fold and the model, and the schema defines them.
 *   · reading the NARRATIVE is never fold's job. The model already read it, in whatever language
 *     it was written. Ask it.
 *
 * So what remains here is structural: punctuation and shape, which mean the same thing in every
 * language fold can render. It is a cheap pre-filter deciding whether to SPEND A CALL, and nothing
 * more. Whether the outcome is genuinely in doubt is answered by the classifier's `contested`
 * field, which is a reading-comprehension question the model answers in any language.
 */

/** Out-of-character asides. Punctuation, not vocabulary — these markers are conventions, not words. */
const OOC = /^\s*(?:\(\(|\[\[|\{\{|\/\/|ooc\b)/i;

/** Paired quotation marks across the scripts SillyTavern renders. */
const QUOTED = /"[^"]*"|“[^”]*”|‘[^’]*’|«[^»]*»|「[^」]*」|『[^』]*』|„[^"]*"/g;

/**
 * Remove quoted speech.
 *
 * What a character SAYS is not what they attempt — a threat in dialogue is a sentence, not a stab.
 * The quotation marks covered include CJK corner brackets and guillemets, because the alternative
 * is a gate that treats every line of Japanese dialogue as an action.
 *
 * @param {string} text Raw message.
 * @returns {string} The text outside quotes.
 */
export function withoutSpeech(text) {
    return String(text ?? '').replace(QUOTED, ' ');
}

/**
 * The fewest words that can plausibly describe an attempt.
 *
 * Counted with `Intl.Segmenter`, not by splitting on spaces and not by counting characters. Both
 * shortcuts fail on the same axis this whole rewrite is about: spaces do not delimit words in
 * Chinese or Japanese, and a character count punishes them for being dense — "我爬上外墙，试图翻过去"
 * is a full sentence in twelve characters and would have been dismissed as too short to be an
 * attempt. Segmenter is the standard primitive for exactly this and ships in every browser
 * SillyTavern runs in.
 *
 * Two, not three. Korean is agglutinative — 성벽을 기어오른다 ("I climb the rampart") is a complete
 * attempt in two word units — and a threshold tuned on English quietly excludes whole languages.
 * This exists to skip "ok", "yes" and a nod, nothing more; judging whether the outcome is in doubt
 * is the classifier's job, in whatever language the player wrote.
 */
export const MIN_ATTEMPT_WORDS = 2;

/**
 * Count word-like segments in any script.
 * @param {string} text Input.
 * @returns {number} Words.
 */
export function wordCount(text) {
    const said = String(text ?? '');
    if (!said.trim()) {
        return 0;
    }
    if (typeof Intl?.Segmenter === 'function') {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
        return [...segmenter.segment(said)].filter(part => part.isWordLike).length;
    }
    // Only reached on a runtime without Segmenter. Space-splitting is wrong for CJK, which is why
    // it is the fallback and not the implementation.
    return said.split(/\s+/).filter(Boolean).length;
}

/**
 * Is this message worth adjudicating?
 *
 * A pre-filter, not a decision. It answers "could this contain an attempt?" — structurally, in any
 * language — and lets the classifier answer whether the outcome is actually in doubt. A false
 * positive here costs one small call and usually returns "uncontested"; a false negative would
 * silently disable the feature, which is the failure that matters.
 *
 * @param {string} text The player's message.
 * @returns {{attempt: boolean, why: string}} The decision and its reason.
 */
export function looksLikeAttempt(text) {
    const said = String(text ?? '').trim();
    if (!said) {
        return { attempt: false, why: 'empty' };
    }
    if (OOC.test(said)) {
        return { attempt: false, why: 'out of character' };
    }

    const action = withoutSpeech(said).trim();
    if (!action || !wordCount(action)) {
        // Every word was inside quotes: the message is dialogue.
        return { attempt: false, why: 'speech only' };
    }
    if (wordCount(action) < MIN_ATTEMPT_WORDS) {
        return { attempt: false, why: 'too short to be an attempt' };
    }
    return { attempt: true, why: 'has narration' };
}
