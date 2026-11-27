/*
  ClipGen AI backend · word lists used by the moment scorer and by caption keyword highlighting.
  These are plain heuristics (English). They are cues, not understanding — the UI says so, and an optional LLM
  pass (llm.js) can refine the ranking when the host configures one.
*/
const set = (s) => new Set(s.split(/\s+/).filter(Boolean));

export const STOPWORDS = set(`a an the and or but if then so of to in on at for from by with as is are was were be been being am i you he she it we they me him her us them my your his its our their this that these those there here what which who whom whose when where why how not no yes do does did done have has had having will would can could should may might must just very really also too than about into over under up down out off again once only own same such more most some any each few other all both can't don't doesn't didn't won't isn't aren't wasn't weren't i'm you're he's she's it's we're they're i've you've we've they've i'll you'll we'll they'll i'd you'd we'd they'd let's that's what's there's gonna wanna gotta like um uh uhh umm yeah okay ok oh`);

export const HOOK_STARTS = [
  /^(did you know|do you know|have you ever|what if|imagine|picture this|listen|look|okay so|here'?s (the|a|what|why|how)|the (secret|truth|reason|biggest|worst|best|first|one thing)|this is (why|how|the)|let me tell you|you won'?t believe|nobody (tells|talks)|stop|never|don'?t|the (problem|mistake) (is|with)|how to|why (do|does|is|are|did|you|most)|what (happens|most|i)|if you (want|ever|are|'re)|everyone|most people|one (day|time)|so (i|we) (just|literally))/i
];
export const HOOK_WORDS = set(`secret truth mistake biggest worst best shocking crazy insane unbelievable never always nobody everyone free proven simple easy hack trick`);

export const EMOTION = set(`love hate amazing awesome incredible terrible horrible awful beautiful wonderful fantastic perfect worst best happy sad angry mad scared afraid terrified excited nervous proud ashamed sorry cry crying cried tears heartbroken devastated thrilled obsessed furious disgusting painful hurt hurts miss missed lost lose grateful blessed emotional shaking nightmare dream hope fear brave`);
export const SURPRISE = set(`wow whoa omg unbelievable shocked shocking shock surprise surprised surprising suddenly literally actually seriously insane crazy wild unreal speechless jaw-dropping can't-believe no-way impossible mindblowing mind-blowing twist plot unexpected randomly`);
export const SURPRISE_PHRASES = [/no way/i, /oh my (god|gosh)/i, /can'?t believe/i, /what the/i, /are you (serious|kidding)/i, /out of nowhere/i, /you won'?t believe/i, /wait,? what/i, /holy (cow|crap|moly|smokes)/i];
export const FUNNY = set(`haha hahaha lol lmao funny hilarious joke jokes laugh laughing laughed laughs ridiculous stupid dumb silly weird clown roast prank banter`);
export const LAUGH_MARKERS = /\[(?:laughter|laughing|laughs)\]|\((?:laughter|laughing|laughs)\)|\*(?:laughs|laughter)\*|\bha(?:ha)+\b/i;
export const INFO = set(`because reason tip tips step steps first second third finally important key lesson learn learned learning rule rules mistake mistakes how why method technique strategy system process example result results data study research percent proven works explain explained means actually difference compare versus better worse cost price save saves earn`);
export const STORY = set(`then suddenly later finally eventually remember told said asked replied walked drove called texted happened started began ended once yesterday today tonight morning night years ago when while after before until`);
export const STORY_PHRASES = [/\bone (day|time|night|morning)\b/i, /\band then\b/i, /\bso (i|we|he|she|they)\b/i, /\bwhen i\b/i, /\bi was\b/i, /\bwe were\b/i, /\bit was\b/i, /\bturns out\b/i, /\blong story short\b/i];
export const CONTINUATION_START = /^(and|but|so|because|which|that|or|then|also|plus|anyway|though|although|however)\b/i;
export const NUMBER = /\b\d[\d,.]*\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion)\b/i;

export const normWord = (w) => String(w).toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
// Words a sentence cannot sensibly end on. A clip whose last word is one of these (or a trailing dash/comma) was cut mid-thought.
export const DANGLING_END = set(`a an the and or but so to of with that which because if for in on at by from as than then who whom whose when where while although though since until unless whether my your his her its our their this these those some any each every both either neither is are was were be been am will would can could should may might must do does did has have had not no very really just also too more most`);
