// Table talk. Each line belongs to an event and, where it matters, a personality ("voice").
// {opp} is the other player in the moment (who they beat, who beat them, who they called).

const LINES = {
  allin: {
    any: ['All in.', 'Let’s gamble.', 'I’m all in. Your move, {opp}.', 'Chips in the middle.'],
    maniac: ['ALL IN BABY', 'Ship it!', 'You only live once.', 'I don’t even need to look.'],
    nit: ['I have it this time. I promise.', 'All in. Yes, really.'],
    fish: ['All in? All in!', 'I feel lucky.'],
    lag: ['Put you to the test, {opp}.', 'Make a decision.'],
    tag: ['All in.', 'Priced in.'],
  },
  lucky: {
    any: ['The lucky hand is back.', 'You know what this is.', 'Never fold the {hand}.'],
    maniac: ['{hand}!! RAISE!', 'The {hand} demands respect.'],
    nit: ['…the one exception to my rules.'],
  },
  herocall: {
    any: ['I don’t believe you.', 'You’re full of it, {opp}.', 'I call. Show me.'],
    hero: ['I know you’re bluffing, {opp}.', 'I’ve seen this movie before.', 'Nope. Calling.'],
    station: ['Call.', 'I’m not folding.'],
    fish: ['Ehh… call?'],
  },
  bigfold: {
    any: ['Good bet. I fold.', 'You win this one, {opp}.'],
    nit: ['Folding. Obviously.', 'I had it, but I fold.', 'Not today.'],
    grinder: ['Wrong price. Fold.', 'Math says no.'],
    tag: ['Nice hand, probably.'],
  },
  steal: {
    any: ['Thank you.', 'I’ll take that.', 'Wasn’t that hard.'],
    maniac: ['Too easy.', 'Scared money, {opp}?', 'Everybody folds to me.'],
    lag: ['Tough spot. Shame.', 'I’ll show you one day.'],
  },
  win: {
    any: ['Ship it.', 'Nice pot.', 'Thanks for the chips, {opp}.', 'That’ll do.'],
    maniac: ['WHO’S NEXT?', 'Run it back!', 'Told you.'],
    nit: ['As expected.', 'Patience pays.'],
    fish: ['I won?! I won!', 'Wait, really?'],
    tag: ['Good game.', 'Standard.'],
    grinder: ['Plus EV.', 'The math works.'],
    station: ['Knew you had nothing.'],
  },
  heroRight: {
    any: ['Knew it!', 'I KNEW IT.', 'Read you like a book, {opp}.'],
    hero: ['Never doubt me.', 'I can smell a bluff, {opp}.'],
  },
  heroWrong: {
    any: ['…okay, you had it.', 'Fine. Nice hand.'],
    hero: ['I still think you were bluffing.', 'That was a bluff in spirit.'],
    station: ['Had to see it.'],
  },
  suckout: {
    any: ['Sorry, {opp}.', 'River gods love me.', 'Didn’t see that coming either.'],
    maniac: ['NEVER IN DOUBT', 'I play for the river.'],
    fish: ['I needed that card!', 'See? It works!'],
  },
  badbeat: {
    any: ['Unbelievable.', 'Every. Single. Time.', 'You called with THAT, {opp}?'],
    nit: ['This is why I don’t play hands.', 'Rigged.'],
    tag: ['Played it right. That’s poker.', 'Variance.'],
    grinder: ['Correct play. Bad result.'],
    hero: ['How?!'],
  },
  lose: {
    any: ['Nice hand.', 'Ugh.', 'Well played, {opp}.'],
    maniac: ['I’ll get it back.', 'Next hand. Next hand.'],
    nit: ['That hurt.'],
  },
  rebuy: {
    any: ['Reloading.', 'One more buy-in.', 'I’m not done yet.'],
    fish: ['ATM is open again.', 'Okay, last buy-in. Probably.'],
    maniac: ['Reload! Let’s go!'],
  },
  tilt: {
    any: ['That’s it. I’m playing every hand now.', 'I’m fine. Totally fine.', 'Somebody’s paying for that.'],
    maniac: ['Oh it is ON now.'],
    nit: ['…deep breaths.'],
  },
};

const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function line(event, voice, vars = {}) {
  const set = LINES[event];
  if (!set) return '';
  // Mostly their own voice when they have one, sometimes something generic.
  const own = set[voice];
  const text = own && Math.random() < 0.7 ? pick(own) : pick(set.any);
  return text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
