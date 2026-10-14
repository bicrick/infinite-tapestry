-- Fewer moderation false positives without weakening the hard lines (sexual/nudity, minors + sexual, slurs).
-- Benign phrases are removed before the keyword match (mirrors ALLOW in web/lib/moderate.js and _ALLOW in guard.py).
create or replace function public.mod_allow(t text) returns text language sql immutable as $$
  select regexp_replace(coalesce(t, ''),
    '\m(naked mole[- ]?rats?|naked eye|naked flame|naked (tree|trees|branches)|(chicken|turkey|duck|pheasant) breasts?|breast ?strokes?|breastplates?|'
    '(blue|great|coal|marsh|willow|crested|long[- ]tailed) tits?|tit ?mouse|tit for tat|'
    '(comic|landing|film|las vegas|vegas|sunset|mobius|bacon|neon|led|light) strips?|strip malls?|strip mines?|'
    '(baby|babies|kid|kids) (animals?|elephants?|goats?|lambs?|sheep|deer|fawns?|bears?|pandas?|seals?|owls?|ducks?|ducklings?|chicks?|birds?|turtles?|dragons?|dinosaurs?|whales?|dolphins?|foxes|fox|wolves|wolf|lions?|tigers?|cats?|kittens?|dogs?|puppies|puppy|bunnies|bunny|rabbits?|penguins?|otters?|giraffes?|horses?|ponies|pony|monkeys?|koalas?|sloths?|octopus(es)?|sharks?|cows?|pigs?|piglets?|yoda|groot|carrots?|spinach|corn|shower|grand|steps?|teeth)|'
    '(kids|kid|children|child)[''’]?s? (toys?|books?|drawings?|crayons?|cartoons?|tv|show|menu|meal|room|playground|blocks?|lego)|'
    'toy (box|store|shop|blocks?)|kid goats?|sex pistols|middlesex|sussex|essex)\M', ' ', 'gi')
$$;

create or replace function public.is_sexual(t text) returns boolean language sql immutable as $$
  select public.mod_allow(t) ~* '\m(sex|sexy|sexual|nude|nudes|naked|nudity|erotic|erotica|porn|porno|nsfw|topless|lingerie|genitals?|penis|vagina|nipples?|orgasm|seductive|sensual|fetish|bdsm|lewd|hentai|undress\w*|stripper|striptease|intercourse|masturbat\w*|boobs?|tits|breasts|xxx|horny|kinky)\M'
$$;

create or replace function public.is_minor_ref(t text) returns boolean language sql immutable as $$
  select public.mod_allow(t) ~* '\m(child|children|kid|kids|minor|minors|underage|under-age|teen|teens|teenage|teenager|preteen|pre-teen|toddler|baby|babies|infant|schoolgirl|schoolboy|loli|lolita|shota|jailbait|young girl|young boy|little girl|little boy|\d{1,2}\s*(yo|y/o|year[- ]old))\M'
$$;
