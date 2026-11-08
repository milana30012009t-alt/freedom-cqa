// Multilingual (RU / KZ / EN) phrase patterns for the offline detectors.
// Text is normalised before matching: lower case, "ё" -> "е", typographic apostrophes -> "'".
// Patterns are deliberately explicit so every offline conclusion can be explained.

const L = '(?<![\\p{L}\\p{N}])';
const R = '(?![\\p{L}\\p{N}])';

/** Whole-word alternatives. */
const words = (...parts) => new RegExp(`${L}(?:${parts.flat().join('|')})${R}`, 'u');
/** Alternatives that only need a left word boundary (stems / prefixes). */
const stems = (...parts) => new RegExp(`${L}(?:${parts.flat().join('|')})`, 'u');

export function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’‘`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export const LEX = {
  greetingFormal: {
    RU: words('здравствуйте', 'здраствуйте', 'добрый (?:день|вечер)', 'доброе утро', 'доброго (?:дня|вечера|утра|времени суток)', 'приветствую'),
    KZ: words('сәлеметсіз(?: бе)?', 'сәлеметсіздер(?: ме)?', 'қайырлы (?:күн|таң|кеш)', 'армысыз'),
    EN: words('hello', 'hi', 'good (?:morning|afternoon|evening|day)', 'greetings'),
  },
  greetingInformal: words('привет', 'приветик', 'здрасте', 'здрасьте', 'хай', 'салют', 'сәлем', 'салем', 'hey', 'yo'),
  maskedName: /\[(?:имя|name|аты)[^\]]{0,20}скрыт[^\]]*\]|\[(?:name|имя) hidden\]/iu,
  introPhrase: words('меня зовут', 'мое имя', 'на связи', 'менің атым', 'атым', 'my name is', 'this is'),
  companyName: stems('фридом', 'freedom', 'федеброкер', 'фридомброкер', 'компания'),

  farewell: words(
    'до свидания', 'всего доброго', 'всего хорошего', 'хорошего (?:дня|вечера|утра|настроения|выходных)', 'до встречи',
    'удачного дня', 'прощайте', 'доброго дня',
    'сау болыңыз', 'сау бол', 'күніңіз сәтті(?: өтсін)?', 'қош болыңыз',
    'goodbye', 'good bye', 'bye', 'have a (?:good|great|nice|lovely) (?:day|evening|one|weekend)', 'take care', 'see you',
  ),
  closingFormula: words(
    'благодарю (?:вас )?за (?:обращение|звонок|ожидание|уделенное время)', 'спасибо за (?:обращение|звонок)',
    'хабарласқаныңызға (?:көп )?рақмет', 'thanks for (?:reaching out|contacting us|calling)', 'thank you for (?:contacting|reaching out|calling)',
  ),
  courtesyAck: words(
    'пожалуйста', 'рад(?:а)? помочь', 'рад(?:а)? была помочь', 'рад(?:а)?, что получилось', 'отлично', 'обращайтесь', 'хорошо',
    'оқасы жоқ', 'көмегім тигеніне қуаныштымын', 'жақсы',
    "you're welcome", 'you are welcome', 'happy to help', 'glad (?:to help|you got in|it worked|i could help)', 'great', 'of course',
  ),
  offerHelp: words(
    'остались (?:ли )?(?:у вас )?(?:еще )?(?:какие-?(?:то|либо) )?вопросы', 'могу (?:ли я )?(?:еще )?чем-?(?:то|нибудь) помочь',
    '(?:есть|будут) (?:еще )?вопросы', 'дополнительные вопросы', 'если (?:вопрос|вопросы|что-?то) (?:останется|останутся|возникнет|возникнут|появятся)',
    'напишите нам', 'обращайтесь', 'стали дополнительные вопросы',
    'если (?:у вас )?(?:появятся|возникнут|останутся|будут) (?:еще |какие-?(?:то|либо|нибудь) )?вопрос(?:ы|ов)?',
    'тағы (?:қандай )?сұрақ', 'басқа сұрағыңыз', 'сұрақтарыңыз болса', 'сұрақ(?:тарыңыз)? туындаса',
    'anything else', 'any other questions', 'feel free to (?:reach out|contact us|write)', 'if (?:you have|there are) (?:any )?(?:more |other |further )?questions', 'let us know', 'come back',
  ),
  summary: stems(
    'вопрос (?:о|по) [\\p{L} ]{0,30}передан', 'вопрос передан', 'передал', 'передан', 'сообщим', 'добавил', 'перед переводом', 'начните со?',
    'дождитесь', 'мы ответим', 'проверьте',
    'жауапты осында', 'жібереміз', 'қостым', 'жолдадым',
    "we'll follow up", 'we will follow up', 'sent the case', 'the case',
  ),

  polite: stems('пожалуйста', 'спасибо', 'извините', 'прошу прощения', 'благодар', 'будьте добры', 'приятно (?:с вами )?познакомиться',
    'өтінемін', 'рақмет', 'кешіріңіз', 'ғафу', 'please', 'thank', 'sorry', 'apolog', "you're welcome", 'glad'),
  empathy: stems('понимаю', 'понятно ваше', 'сочувству', 'неприятн', 'беспоко', 'пережива', 'извините за', 'мне жаль',
    'түсінемін', 'алаңда', 'i understand', 'understand why', 'sorry to hear', 'sorry for', 'i can see why', 'i hear you'),
  apologyForWait: stems('спасибо (?:за|что) (?:ожидание|подождали)', 'благодарю (?:вас )?за ожидание', 'извините за (?:ожидание|задержку)',
    'спасибо, что подождали', 'күткеніңізге рақмет', 'thanks for (?:waiting|your patience)', 'thank you for (?:waiting|your patience)', 'sorry for the (?:wait|delay)'),
  waitWarning: stems('сейчас (?:проверю|посмотрю|уточню|узнаю)', 'минуту', 'минутку', 'одну минуту', 'секунду', 'подождите', 'ожидайте',
    'ожидать на линии', 'уточню', 'проверю', 'давайте я (?:сейчас )?посмотрю', 'күте тұрыңыз', 'бір минут', 'тексеріп көрейін',
    'one moment', 'let me check', 'please wait', 'hold on', 'bear with me'),

  insult: stems(
    'вы (?:вообще )?читать (?:умеете|не умеете)', 'вы что,? (?:тупо|глух|слеп)', 'тупой', 'тупая', 'идиот', 'дурак', 'дура(?![\\p{L}])', 'бестолков',
    'безграмотн', 'не тупите', 'заткни', 'ваши проблемы', 'не мои проблемы', 'отстаньте',
    'оқи алмайсыз ба', 'оқуды білмейсіз бе', 'ақымақ', 'миың жоқ',
    "can't you read", 'can you even read', 'are you stupid', 'idiot', 'stupid', 'dumb', 'not my problem', 'shut up',
  ),
  dismissive: new RegExp(`(?:^ну,? (?:тогда|так|ладно)${R}|${L}тогда не знаю|^не знаю[.!]?$|${L}вс[её] есть в приложении|${L}ничего не (?:сделать|поделать)|${L}я (?:уже )?указал|${L}разбирайтесь|${L}это не ко мне|^білмеймін|${L}whatever|${L}figure it out|${L}that's where|^i don't know[.!]?$|${L}not my job)`, 'u'),
  vague: stems('там же', 'где-?то', 'сверху вниз', 'поищите', 'как-?нибудь', 'профильге кіріңіз', 'тапсырмалардан іздеңіз', 'somewhere', 'look around', 'try to find'),
  concrete: new RegExp(`(?:«[^»]{2,}»|→|->|"[^"]{2,}"|tradernet\\.global|${L}(?:откройте|выберите|нажмите|перейдите|введите|скачайте|зайдите|снимите|укажите|используйте|воспользуйтесь|ашыңыз|таңдаңыз|басыңыз|енгізіңіз|жүктеңіз|жүктеп алыңыз|өтіңіз|толтырыңыз|алып тастаңыз|open|select|choose|click|tap|go to|enter|download|untick|search|fill in|sign in)${R})`, 'u'),
  yesNoAnswer: words('да', 'нет', 'можно', 'нельзя', 'не нужно', 'не надо', 'иә', 'жоқ', 'болады', 'yes', 'no', "can't", 'cannot'),

  genericHelp: stems('чем (?:я )?(?:могу|можем) (?:вам )?помочь', 'с чем (?:вам )?помочь', 'какой у вас вопрос', 'что у вас случилось', 'слушаю вас',
    'қалай көмектесе аламын', 'не көмек керек', 'сізге қалай көмектесейін', 'how can i help', 'how may i help', 'what can i (?:do|help)', 'how can we help'),

  clientAlreadySaid: stems('я (?:же )?(?:уже )?(?:писал|писала|сказал|сказала|говорил|говорила|указал)', '(?:писал|писала) выше', 'выше (?:писал|написал|писала)',
    'уже (?:писал|писала|говорил)', 'жоғарыда жаздым', 'айттым ғой', 'жаздым ғой', 'жазғанмын',
    'i (?:already )?(?:said|wrote|told you|mentioned)', 'as i (?:said|wrote|mentioned)', 'i just said'),
  clientCorrection: stems('какое приложение', 'я (?:вообще )?(?:на|с) (?:компьютер|ноутбук|сайт)', 'я (?:даже )?(?:не|еще не) (?:назвал|называл|подтверждал|говорил)',
    'почему точно', 'откуда вы знаете', 'ондай [\\p{L} ]{0,20}жоқ', 'растаған жоқпын', 'which app', "i'm on the company", 'how do you know', "i haven't verified",
    'settings where'),
  clientConfusion: stems('в каком (?:меню|разделе|месте)', 'где именно', 'не понял', 'не поняла', 'не понимаю', 'непонятно', 'что (?:вы )?имеете в виду', 'в смысле',
    'куда (?:именно )?(?:нажать|зайти)', 'түсінбедім', 'қай жерде', 'ондай [\\p{L} ]{0,20}жоқ', 'what do you mean', 'which (?:menu|one|page|button)',
    "i don'?t understand", 'settings where', "i'm (?:still )?confused"),
  clientDissatisfied: stems('надоело', 'вы серьезно', 'так говорить не надо', 'со мной так', 'безобрази', 'возмутительн', 'ужас', 'беспоко', 'пережива',
    'нервнича', 'сколько можно', 'я спрашиваю', 'почему точно', 'отфутболи', 'неприятн', 'навязываюсь', 'я (?:еще|даже) не подтверждал',
    'мазам', 'ренжі', 'шаршадым', 'растаған жоқпын',
    'nervous', 'seriously', 'frustrat', 'annoy', 'ridiculous', 'how do you know', "i haven't verified", 'unacceptable', 'worried'),
  clientResolved: stems('нашел', 'нашла', 'нашлось', 'получилось', 'теперь вижу', 'вижу', 'понятно', 'понял', 'поняла', 'ясно', 'скачал', 'скачалось',
    'убрал', 'зашел', 'вошел', 'готово', 'сработало', 'разобрал', 'спасибо', 'это вс[её] что', 'это (?:я и )?хотел(?:а)? узнать',
    'то,? что нужно', 'больше ничего',
    'таптым', 'көрдім', 'түсіндім', 'түсінікті', 'ашылды', 'жүктелді', 'өшірдім', 'дайын болды', 'рақмет',
    'found it', 'got it', 'that worked', 'it works', 'thanks', 'thank you', 'understood', 'i see', 'that helps', 'got them', "that's all", "that's the page",
    'all i needed', "that's what i needed"),
  // Corrections about the client's situation (device, site, item) — used for need discovery.
  clientContextCorrection: stems('какое приложение', 'я (?:вообще )?(?:на|с) (?:компьютер|ноутбук|сайт)', 'я (?:даже )?(?:не|еще не) (?:назвал|называл)(?! подтвер)',
    'почему точно', 'откуда вы знаете', 'which app', "i'm on the company", 'settings where', 'i (?:never|didn\\x27t) (?:say|mention)',
    'я (?:же )?(?:про|о) [\\p{L} ]{1,40}спрашивал', 'я спрашивал(?:а)? (?:про|о)', 'i (?:was )?ask(?:ed|ing) about', 'мен .{0,30}сұрадым'),
  // Topic vocabulary: a sentence with one of these stems describes the request itself.
  domainTopic: stems('тариф', 'комисс', 'сч[её]т', 'вывод', 'вывес', 'отч[её]т', 'реквизит', 'пополн', 'перевод', 'облигац', 'акци', 'бумаг', 'приказ',
    'поручени', 'логин', 'вход', 'сайт', 'кабинет', 'налог', 'форм[ау]', '1042', 'марж', 'портфел', 'позици', 'тикер', 'котировк', 'анкет', 'сведени',
    'регистр', 'платеж', 'деньг', 'карт', 'торгов', 'бирж', 'валют', 'отчетност', 'd-сч',
    'шот', 'шығар', 'есеп', 'есеб', 'деректеме', 'аудар', 'ақша', 'қағаз', 'өтінім', 'нысан', 'тіркел', 'анкета', 'кабинет', 'күндер',
    'plan', 'pricing', 'fee', 'account', 'withdraw', 'report', 'statement', 'transfer', 'fund', 'bond', 'stock', 'order', 'login', 'sign-in', 'sign in',
    'website', 'form', 'tax', 'margin', 'ticker', 'securit', 'details', 'profile', 'financial'),
  operatorRequest: stems('оператор', 'человек', 'сотрудник', 'специалист', 'подключите', 'соедините', 'позовите', 'переключите', 'дайте',
    'адаммен', 'қосыңыз', 'жалғаңыз', 'қоса аласыз', 'агент', 'agent', 'person', 'someone', 'human', 'connect me', 'put me through', 'speak to', 'talk to', 'support'),
  confirmationOnly: /^(?:да|нет|ага|ок|окей|иә|жоқ|yes|no|ok|okay|yes please|да,? пожалуйста|иә,? (?:рақмет|қосыңызшы)|готов[а]?|хорошо)[.!]?$/u,

  forward: new RegExp(`${L}(?:переда(?:м|л|ю|ла|ем)|передан|направ(?:лю|ил|ила|им|ляю)${R}|специалист(?:ам|у|ов)${R}|на проверку|профильн|(?:технический |профильный )?отдел(?:у|а|ом)?${R}|мамандарға|жолда(?:ймын|дым|ймыз|й аламын)|тексеруге|жібер(?:емін|дім)${R}|send (?:it|this|the case) to|sent the case|forward(?:ed)?${R}|escalat|the team|for review)`, 'u'),
  followUpCommit: stems('сообщ(?:им|у)', 'ответ(?:им|ят)', 'свяж(?:емся|усь)', 'перезвон', 'позвон(?:ю|им)', 'напиш(?:ем|у)', 'в этом чате', 'в течение',
    'сегодня', 'завтра', 'рабоч', 'до \\d', 'с \\d{1,2}:\\d{2}', 'обратн(?:ую|ая) связь', 'как только', 'осында', 'хабарла(?:ймыз|ймын)', 'жауапты осында',
    "we'll (?:follow up|get back|contact|update|let you know)", 'we will (?:follow up|get back|contact|update)', 'in this chat', 'follow up here', 'within',
    'by (?:today|tomorrow|end of)', 'business day', 'once there'),
  clientNextAction: stems('напишите', 'если (?:вопрос )?(?:останется|не решится)', 'обратитесь', 'сообщите', 'позвоните', 'свяжитесь', 'дождитесь', 'повторите',
    'жіберіңіз', 'хабарласыңыз', 'жазыңыз', 'let us know', 'contact us', 'reach out', 'come back', 'wait for', 'you can return'),
  clientAsksFollowUp: stems('когда', 'через сколько', 'сколько ждать', 'как долго', 'мне (?:ответят|напишут|позвонят|сообщат)', 'я (?:получу|узнаю)',
    'вы (?:сами )?(?:позвоните|перезвоните)', 'қашан', 'қанша уақыт', 'when', 'how long', 'will i hear', 'hear back', 'will you (?:call|contact|let me know)'),

  idRequired: stems('идентификаци', 'подтверд(?:ить|им|ите) личность', 'подтверждение личности', 'верификаци', 'проверк[аиу] личности', 'фамили[юяи]',
    'полное имя', 'ваш (?:ин|иин)', 'жеке басыңызды раста', 'растау қажет', 'сәйкестендір',
    'verify your identity', 'identity verification', 'confirm your identity'),
  idConfirmedByOperator: stems('идентификаци\\p{L}* (?:успешно|пройден)', 'успешно про(?:шли|йдена|еданная|ведена)', 'вс[её] верно', 'данные совпадают', 'спасибо за информацию',
    'расталды', 'you(?:\\s|\\x27)?re verified', 'identity (?:is )?verified'),
  accountDisclosure: stems('(?:на|в) вашем (?:брокерском |торговом )?сч[её]т', 'у вас на сч[её]те', 'я (?:посмотрел|посмотрела|проверил|проверила)',
    'я (?:вижу|наблюдаю)', 'вижу,? что (?:у вас|на вашем|вы)', 'на сч[её]те (?:есть|имеется|стоит|наложен)', 'ограничени[ея] на вывод',
    'шотыңызда', 'көріп тұрмын', 'on your account', 'i can see (?:a|an|the|your)', 'i (?:checked|looked at) your account', 'your account (?:has|shows|is)'),
  idDismissal: stems('подтверждение (?:пока |сейчас )?не (?:нужно|требуется)', 'без (?:подтверждения|идентификации)', 'можно без проверки', 'не нужно подтверждать',
    'растаудың қажеті жоқ', 'растамай-ақ', 'we can skip (?:that|it|verification)', 'no need to verify', 'skip (?:the )?verification'),
  clientAccountRequest: stems('мо(?:й|ем|его|им) сч[её]т', 'с моим сч[её]том', 'мой платеж', 'проверьте', 'посмотрите,? что', 'проверить (?:сам )?сч[её]т',
    'проверил платеж', 'чтобы человек проверил', 'вывод (?:ограничен|заблок)', 'вчера вывод работал', 'нужно именно проверить', 'не зачисл',
    'денег вс[её] еще нет', 'поменялся тариф', 'мне надо понять причину', 'уже отправила', 'уже отправил',
    'шотымда', 'шотқа ақша аудардым', 'көрінбей тұр', 'қарап беріңіз', 'менің шотым',
    'my account', 'check (?:my|the) (?:account|transfer)', "hasn't shown up", 'blocked on my account', "i've already sent", 'check the transfer'),

  personalTransfer: new RegExp(`(?:${L}(?:скиньте|переведите|перекиньте|отправьте|кидайте|перечислите)[^.!?]{0,30}(?:мне|на (?:мою|мой|личн))|${L}мне на карт|${L}на (?:мою|личную) карт|${L}на мой (?:личный )?(?:сч[её]т|номер|кошел[её]к)|${L}маған (?:аударыңыз|жіберіңіз)|${L}картама|${L}send (?:the |your )?money to me|${L}transfer[^.!?]{0,20}to (?:me|my)${R}|${L}to my personal (?:card|account))`, 'u'),
  profitPromise: stems('с выгодой', 'гарантир\\p{L}* (?:доход|прибыл|рост)', 'доход гарантир', 'точно (?:вырастут|заработаете|принесут)', 'без риска', 'удво(?:ю|им|ите)',
    'пайда (?:табасыз|әкеледі)', 'кепілді табыс', 'guarantee\\p{L}* (?:a )?(?:return|profit)', "you(?:'ll| will) (?:definitely )?(?:earn|make|profit)", 'risk-free', 'double your'),
  bypassExplicit: stems('лично предлагаю', 'через компанию (?:оформлять )?не (?:надо|нужно)', 'в обход компании', 'вне компании', 'моя частная консультац',
    'outside (?:the )?company', 'off the record', 'not through the company'),
  personalContactRequest: stems('личн\\p{L}* (?:номер|телефон|контакт)', 'дать личный', 'жеке нөмір', 'personal (?:number|phone|contact)', 'your personal number'),
  paidService: stems('за плату', 'платн', 'за деньги', 'за вознаграждение', 'ақылы', 'ақшаға', 'i charge', 'for a fee', 'paid advice', 'for money'),
  privateService: stems('частн', 'лично', 'в обход', 'вне компании', 'вечером созвон', 'созвонюсь', 'после работы', 'жұмыстан кейін', 'private', 'after work', 'personally'),

  otpRequest: stems('(?:смс|sms|с м с|эсэмэс)[-\\s]*(?:код|кот)', 'шестизначн', 'код подтверждения', 'одноразов\\p{L}* (?:код|пароль)', 'продикту\\p{L}*[^.?]{0,50}код',
    'код[^.?]{0,50}продикт', 'назовите код', 'сообщите код', 'пароль', 'cvv', 'cvc', 'пин-?код', 'оттипе', 'типикот', 'смс кодты', 'кодты (?:айтыңыз|жазыңыз)',
    'құпия сөз', '(?:sms|one-time|verification|otp|security) code', 'read (?:me )?the code', '(?:your|the) password', 'pin code'),
  otpLegitContext: stems('для идентификации', 'направ(?:ил|ляю|им|лю|ляющ)', 'прид[её]т', 'пришел', 'пришло', 'отправил', 'на ваш (?:телефон|номер)', 'идентификац'),

  questionWord: new RegExp(`(?:\\?|${L}(?:как|где|когда|почему|зачем|сколько|какой|какая|какое|какие|каким|можно ли|нужно ли|надо ли|а если|что делать|қалай|қайда|қайдан|қашан|неге|қандай|бола ма|how|where|when|why|what|which|can i|do i|is it|will i|should i|does)${R})`, 'u'),
};

const STOP = new Set(`
это этот эта эти тот того там тут здесь как где когда что чтобы если или для при про под над без его она они оно мне меня вам вас ваш ваша ваше ваши мой моя мое мои
есть быть было была были будет можно нужно надо сейчас уже еще тоже только просто очень пожалуйста спасибо хорошо понятно ладно тогда потом
могу может можете нужен нужна нужны какой какая какое какие который которая которые почему зачем сколько через после перед также
бар бола болады керек қазір рақмет және мен сен сіз сізге осы сол бұл қай қалай қайда неге
the and for are you your with that this have has was were will would could should can what where when which there here about please thanks
thank just from into then than them they their our ours its it's i'm don't doesn't okay yes
`.split(/\s+/).filter(Boolean));

/** Content stems used for lightweight topical overlap (first 5 letters of words with >= 4 letters). */
export function contentStems(text) {
  const t = normalizeForMatch(text).replace(/«[^»]*»/g, ' ');
  const out = new Set();
  for (const w of t.split(/[^\p{L}\p{N}-]+/u)) {
    if (w.length < 4 || STOP.has(w)) continue;
    out.add(w.slice(0, 5));
  }
  return out;
}

export function matchFirst(re, text) {
  const m = re.exec(normalizeForMatch(text));
  return m ? m[0] : null;
}

export function test(re, text) {
  return re.test(normalizeForMatch(text));
}
