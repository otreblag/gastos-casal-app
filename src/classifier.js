// ─── CLASSIFICADOR LOCAL DE GASTOS ───────────────────────────────────────────
// Sem API, sem internet. Tudo roda no próprio código.

const DEFAULT_CATEGORIES = [
  {
    id: 'mercado',
    nome: 'Mercado',
    icone: '🛒',
    cor: '#1D9E75',
    palavras: [
      'mercado', 'supermercado', 'hipermercado', 'mercearia', 'hortifruti', 'feira',
      'sacolão', 'açougue', 'pão', 'leite', 'carne', 'frango', 'peixe',
      'verdura', 'legume', 'fruta', 'mantimento', 'compra', 'compras', 'atacado',
      'atacadão', 'assaí', 'carrefour', 'extra', 'walmart', 'pão de açúcar',
      'big', 'condor', 'angeloni', 'bistek', 'giassi', 'comper', 'nacional',
      'formula', 'max', 'smart', 'dia', 'sonda', 'cobal', 'coop', 'seara',
      'sadia', 'nestlé', 'frios', 'laticinio', 'laticinios', 'queijo', 'iogurte',
      'manteiga', 'ovos', 'arroz', 'feijão', 'macarrão', 'farinha', 'açúcar',
      'sal', 'óleo', 'azeite', 'tempero', 'molho', 'enlatado', 'conserva',
      'biscoito', 'bolacha', 'salgadinho', 'chocolate', 'café', 'chá', 'suco',
      'refrigerante', 'água', 'cerveja', 'vinho', 'bebida', 'higiene', 'sabão',
      'detergente', 'limpeza', 'papel higiênico', 'shampoo', 'condicionador',
      'creme', 'pasta de dente', 'escova', 'desodorante', 'absorvente', 'fralda',
      'lenço', 'esponja', 'vassoura', 'rodo', 'balde',
      'quitanda', 'peixaria', 'empório', 'mercadinho', 'minimercado', 'granel',
      'papel alumínio', 'filme plástico', 'guardanapo', 'palha de aço',
      'saco de lixo', 'inseticida', 'álcool em gel', 'desinfetante'
    ]
  },
  {
    id: 'alimentacao',
    nome: 'Alimentação',
    icone: '🍽️',
    cor: '#3266ad',
    palavras: [
      'restaurante', 'lanchonete', 'padaria', 'confeitaria', 'ifood', 'i food', 'uber eats', 'rappi',
      'delivery', 'hamburguer', 'hamburger', 'burger', 'pizza', 'pizzaria',
      'sushi', 'japonês', 'japonesa', 'churrasco', 'churrascaria', 'rodizio',
      'rodízio', 'buffet', 'almoço', 'jantar', 'café da manhã', 'lanche',
      'pastel', 'coxinha', 'esfiha', 'esfirra', 'tapioca', 'crepe', 'wrap',
      'sanduíche', 'sanduiche', 'hot dog', 'cachorro quente', 'frango frito',
      'mc donald', 'mcdonalds', 'mc donalds', 'bk', 'burger king', 'bob',
      'giraffas', 'outback', 'coco bambu', 'madero', 'frango assado',
      'porcão', 'fogo de chão', 'spoleto', 'subway', 'kfc', 'popeyes',
      'domino', 'dominos', 'pizza hut', 'telepizza', 'habib', 'habibs',
      'chinese', 'árabe', 'italiano', 'mexicano', 'bar', 'boteco', 'bistrô',
      'petisco', 'porção', 'tira gosto', 'sobremesa', 'sorvete', 'gelato',
      'açaí', 'acai', 'smoothie', 'vitamina', 'milk shake', 'milkshake',
      'salgado', 'esfirra', 'caldo', 'caldinho', 'marmita', 'marmitex',
      'quentinha', 'refeição', 'comida'
    ]
  },
  {
    id: 'transporte',
    nome: 'Transporte',
    icone: '🚗',
    cor: '#BA7517',
    palavras: [
      'uber', '99', '99pop', 'cabify', 'táxi', 'taxi', 'transfer', 'mototaxi',
      'ônibus', 'onibus', 'busão', 'metro', 'metrô', 'trem', 'barca', 'balsa',
      'brt', 'vlt', 'monotrilho', 'van', 'lotação', 'kombi', 'passagem',
      'bilhete', 'cartão transporte', 'vale transporte', 'gasolina', 'combustível',
      'combustivel', 'etanol', 'álcool', 'alcool', 'diesel', 'gnv', 'posto',
      'ipiranga', 'shell', 'petrobras', 'br', 'ale', 'raízen', 'raizen',
      'estacionamento', 'estacionar', 'parking', 'park', 'zona azul', 'rotatória',
      'pedágio', 'pedagio', 'sem parar', 'conectcar', 'veloe', 'portobello',
      'oficina', 'mecanico', 'mecânico', 'funilaria', 'borracharia', 'pneu',
      'óleo motor', 'revisão', 'revisao', 'seguro carro', 'ipva', 'licenciamento',
      'dpvat', 'multa', 'detran', 'habilitação', 'cnh', 'lavagem', 'lava jato',
      'lava rápido', 'guincho', 'reboque', 'bateria', 'filtro', 'amortecedor',
      'freio', 'pastilha', 'disco', 'embreagem', 'câmbio', 'ar condicionado carro',
      'bicicleta', 'bike', 'patinete', 'scooter', 'moto', 'motocicleta',
      'avião', 'passagem aérea', 'voo', 'latam', 'gol', 'azul', 'tam',
      'aeroporto', 'embarque', 'bagagem', 'mala', 'ônibus interestadual',
      'rodoviária', 'rodoviaria',
      'buser', 'blablacar', 'locação de carro', 'aluguel de carro',
      'multa de trânsito', 'alinhamento', 'balanceamento', 'troca de óleo',
      'ar condicionado do carro', 'seguro veicular', 'ipva atrasado'
    ]
  },
  {
    id: 'saude',
    nome: 'Saúde',
    icone: '💊',
    cor: '#D4537E',
    palavras: [
      'farmácia', 'farmacia', 'drogaria', 'droga', 'remédio', 'remedio',
      'medicamento', 'comprimido', 'cápsula', 'capsula', 'xarope', 'pomada',
      'receita', 'droga raia', 'drogasil', 'pacheco', 'ultrafarma', 'panvel',
      'nissei', 'catarinense', 'globo', 'são paulo', 'popular', 'genérico',
      'generico', 'antibiótico', 'antibiotic', 'vitamina', 'suplemento',
      'whey', 'creatina', 'proteina', 'proteína', 'colágeno', 'colageno',
      'médico', 'medico', 'consulta', 'consulta médica', 'clínica', 'clinica',
      'hospital', 'pronto socorro', 'upa', 'ubs', 'posto de saúde',
      'plano de saúde', 'convenio', 'convênio', 'unimed', 'bradesco saúde',
      'amil', 'sulamerica', 'hapvida', 'notredame', 'intermédica',
      'exame', 'laboratorio', 'laboratório', 'análise', 'analise', 'hemograma',
      'raio x', 'ultrassom', 'ultrassonografia', 'tomografia', 'ressonancia',
      'ressonância', 'mamografia', 'colonoscopia', 'endoscopia', 'eletrocardiograma',
      'dentista', 'odontologico', 'odontológico', 'ortodontia', 'aparelho',
      'extração', 'extracao', 'canal', 'coroa', 'implante', 'limpeza dental',
      'fisioterapia', 'fisioterapeuta', 'quiropraxia', 'acupuntura', 'pilates',
      'psicólogo', 'psicologo', 'psiquiatra', 'terapia', 'nutricionista',
      'cirurgia', 'internação', 'internacao', 'uti', 'curativo', 'atadilho',
      'seringa', 'glicosimetro', 'insulina', 'pressão', 'pressao', 'oximetro',
      'termômetro', 'termometro', 'nebulizador', 'inalação', 'inalacao',
      'telemedicina', 'exame de sangue', 'plano dental', 'oftalmologista',
      'óculos de grau', 'lente de contato', 'aparelho auditivo', 'fralda geriátrica',
      'termômetro digital', 'álcool 70', 'máscara cirúrgica', 'protetor auricular'
    ]
  },
  {
    id: 'moradia',
    nome: 'Moradia',
    icone: '🏠',
    cor: '#888780',
    palavras: [
      'aluguel', 'condomínio', 'condominio', 'iptu', 'água', 'conta de água',
      'luz', 'energia', 'conta de luz', 'conta de energia', 'celesc', 'copel',
      'cemig', 'enel', 'light', 'coelba', 'cpfl', 'eletropaulo', 'sabesp',
      'sanepar', 'caesb', 'embasa', 'gas', 'gás', 'comgas', 'cegás',
      'internet', 'wi-fi', 'wifi', 'banda larga', 'vivo fibra', 'claro net',
      'tim live', 'oi fibra', 'net combo', 'sky', 'telefone fixo', 'residencial',
      'imobiliária', 'imobiliaria', 'corretor', 'financiamento', 'prestação casa',
      'prestacao casa', 'parcela casa', 'caixa', 'habitação', 'habitacao',
      'minha casa', 'reforma', 'obra', 'pedreiro', 'eletricista', 'encanador',
      'pintor', 'pintura', 'tinta', 'cimento', 'tijolo', 'telha', 'piso',
      'porcelanato', 'azulejo', 'rejunte', 'massa', 'gesso', 'drywall',
      'madeira', 'marceneiro', 'marcenaria', 'móveis', 'moveis', 'sofá', 'sofa',
      'cama', 'colchão', 'colchao', 'guarda roupa', 'armário', 'armario',
      'mesa', 'cadeira', 'rack', 'estante', 'prateleira', 'cortina', 'persiana',
      'tapete', 'capacho', 'luminária', 'luminaria', 'lâmpada', 'lampada',
      'tomada', 'interruptor', 'fio', 'cabo', 'cano', 'torneira', 'vaso',
      'pia', 'banheiro', 'box', 'chuveiro', 'ducha', 'aquecedor',
      'ar condicionado', 'ventilador', 'geladeira', 'fogão', 'fogao',
      'microondas', 'lavadora', 'máquina de lavar', 'secadora', 'lava louça',
      'aspirador', 'ferro', 'liquidificador', 'batedeira', 'fritadeira',
      'dedetização', 'dedetizacao', 'limpeza', 'faxina', 'diarista',
      'jardineiro', 'jardinagem', 'consertar', 'conserto', 'manutenção', 'manutencao',
      'chaveiro', 'vidraceiro', 'marido de aluguel', 'seguro residencial',
      'alarme residencial', 'câmera de segurança', 'portão eletrônico',
      'interfone', 'ar condicionado split'
    ]
  },
  {
    id: 'lazer',
    nome: 'Lazer',
    icone: '🎉',
    cor: '#7F77DD',
    palavras: [
      'cinema', 'filme', 'ingresso', 'teatro', 'show', 'festival', 'festa',
      'balada', 'boate', 'bar', 'happy hour', 'aniversário', 'aniversario',
      'presente', 'gift', 'lembrança', 'lembranca', 'parque', 'zoológico',
      'zologico', 'aquário', 'aquario', 'museu', 'exposição', 'exposicao',
      'excursão', 'excursao', 'passeio', 'viagem', 'hotel', 'pousada',
      'hostel', 'airbnb', 'booking', 'trivago', 'decolar', 'cvc', 'submarino',
      'praia', 'clube', 'academia', 'ginásio', 'ginasio', 'piscina',
      'quadra', 'tênis', 'tenis', 'golf', 'surf', 'bodyboard', 'skate',
      'bike', 'trilha', 'camping', 'acampamento', 'chácara', 'chácara',
      'sítio', 'sitio', 'fazenda', 'recanto', 'chalé', 'chale',
      'netflix', 'amazon prime', 'disney plus', 'hbo max', 'globoplay',
      'paramount', 'apple tv', 'deezer', 'spotify', 'youtube premium',
      'twitch', 'steam', 'playstation', 'xbox', 'nintendo', 'jogo', 'game',
      'livro', 'revista', 'kindle', 'audible', 'podcast', 'curso online',
      'udemy', 'hotmart', 'domestika', 'alura', 'dio',
      'brinquedo', 'boneca', 'carrinho', 'lego', 'quebra cabeça',
      'tabuleiro', 'carta', 'baralho', 'futebol', 'vôlei', 'basquete',
      'natação', 'natacao', 'corrida', 'maratona', 'crossfit', 'yoga',
      'zumba', 'dança', 'danca', 'musculação', 'musculacao',
      'ingressos', 'ticketmaster', 'sympla', 'eventbrite', 'bilheteria',
      'parque aquático', 'parque tematico', 'beto carrero', 'hopi hari',
      'parque de diversões', 'escape room', 'boliche', 'sinuca', 'karaokê',
      'vinho e queijo', 'degustação', 'stand up comedy', 'festa infantil',
      'aluguel de casa de temporada', 'temporada airbnb'
    ]
  },
  {
    id: 'assinatura',
    nome: 'Assinatura',
    icone: '📱',
    cor: '#D85A30',
    palavras: [
      'celular', 'telefone', 'plano', 'recarga', 'tim', 'vivo', 'claro',
      'oi', 'nextel', 'algar', 'sercomtel', 'mvno', 'nübank', 'nubank',
      'assinatura', 'mensalidade', 'anuidade', 'plano mensal', 'plano anual',
      'netflix', 'spotify', 'amazon', 'prime', 'disney', 'hbo', 'globoplay',
      'paramount', 'apple', 'icloud', 'google one', 'dropbox', 'onedrive',
      'adobe', 'photoshop', 'illustrator', 'canva', 'figma', 'notion',
      'slack', 'zoom', 'microsoft 365', 'office 365', 'antivirus', 'vpn',
      'dominio', 'domínio', 'hospedagem', 'servidor', 'cloud', 'aws',
      'plano saúde', 'plano odontológico', 'plano odontologico',
      'seguro', 'seguro de vida', 'seguro residencial', 'previdencia', 'previdência',
      'clube de assinatura', 'box mensal', 'tag livros', 'minha biblioteca',
      'deezer', 'tidal', 'youtube', 'twitch', 'patreon', 'substack',
      'gympass', 'totalpass', 'wellhub', 'ifood clube', 'rappi prime',
      'chatgpt', 'claude', 'copilot', 'linkedin premium', 'kindle unlimited',
      'audible', 'globo play', 'star plus', 'crunchyroll', 'discord nitro'
    ]
  },
  {
    id: 'roupas',
    nome: 'Roupas e Calçados',
    icone: '👕',
    cor: '#639922',
    palavras: [
      'roupa', 'roupas', 'vestido', 'blusa', 'camisa', 'camiseta', 'calça',
      'calca', 'short', 'bermuda', 'saia', 'blazer', 'jaqueta', 'casaco',
      'moletom', 'suéter', 'suter', 'tricô', 'trico', 'malha', 'conjunto',
      'pijama', 'roupa de cama', 'lencol', 'lençol', 'toalha', 'cueca',
      'calcinha', 'sutiã', 'sutia', 'meia', 'collant', 'legging', 'lingerie',
      'sapato', 'tênis', 'sandália', 'sandalia', 'chinelo', 'bota', 'scarpin',
      'rasteirinha', 'mocassim', 'sapatilha', 'salto', 'sneaker', 'crocs',
      'bolsa', 'carteira', 'mochila', 'cinto', 'chapéu', 'chapeu', 'boné',
      'bone', 'cachecol', 'luva', 'óculos', 'oculos', 'bijuteria', 'jóia',
      'joia', 'colar', 'brinco', 'pulseira', 'anel', 'relógio', 'relogio',
      'renner', 'riachuelo', 'c&a', 'cea', 'marisa', 'hering', 'zara',
      'h&m', 'forever 21', 'shein', 'amaro', 'dafiti', 'netshoes',
      'centauro', 'decathlon', 'nike', 'adidas', 'puma', 'mizuno', 'asics',
      'olympikus', 'melissa', 'grendene', 'havaianas', 'ipanema',
      'farm', 'animale', 'forum', 'colcci', 'shoulder', 'zinco',
      'alfaiataria', 'costureira', 'costureira', 'costura', 'conserto roupa',
      'sapateiro', 'sapataria', 'reforma sapato'
    ]
  },
  {
    id: 'educacao',
    nome: 'Educação',
    icone: '📚',
    cor: '#378ADD',
    palavras: [
      'escola', 'colégio', 'colegio', 'faculdade', 'universidade', 'vestibular',
      'enem', 'cursinho', 'pré vestibular', 'pre vestibular', 'curso', 'aula',
      'mensalidade escolar', 'matrícula', 'matricula', 'rematrícula', 'material escolar',
      'livro', 'livros', 'apostila', 'caderno', 'cadernos', 'mochila escolar',
      'lapis', 'lápis', 'caneta', 'borracha', 'régua', 'regua', 'compasso',
      'calculadora', 'estojo', 'pasta', 'fichário', 'fichario', 'grampeador',
      'idioma', 'inglês', 'ingles', 'espanhol', 'francês', 'frances',
      'alemão', 'alemao', 'italiano', 'mandarim', 'japonês', 'japones',
      'cna', 'wizard', 'yazigi', 'fisk', 'ccaa', 'cultura inglesa',
      'duolingo', 'babbel', 'rosetta', 'cambly', 'preply',
      'professor particular', 'tutoria', 'reforço', 'reforco',
      'pós graduação', 'pos graduacao', 'mba', 'especialização', 'especializacao',
      'mestrado', 'doutorado', 'tcc', 'monografia', 'projeto',
      'udemy', 'alura', 'coursera', 'edx', 'hotmart', 'domestika',
      'senai', 'senac', 'sebrae', 'sesc', 'certificação', 'certificacao',
      'concurso', 'oab', 'crm', 'conselho', 'registro profissional'
    ]
  },
  {
    id: 'pets',
    nome: 'Pet',
    icone: '🐾',
    cor: '#A0522D',
    palavras: [
      'pet', 'cachorro', 'gato', 'animal', 'bicho', 'ração', 'racao',
      'petshop', 'pet shop', 'veterinário', 'veterinario', 'vet', 'clinica vet',
      'vacina animal', 'vermifugo', 'antipulga', 'antipulgas', 'coleira',
      'brinquedo pet', 'cama pet', 'casinha', 'aquário', 'peixe',
      'pássaro', 'passaro', 'hamster', 'coelho', 'tartaruga',
      'banho e tosa', 'banho tosa', 'tosa', 'grooming', 'adestramento',
      'creche pet', 'hotel pet', 'petsitting', 'passeador', 'dog walker',
      'areia sanitária', 'areia sanitaria', 'caixa de areia', 'comedouro',
      'bebedouro', 'arranhador', 'guia', 'focinheira', 'casinha',
      'pedigree', 'whiskas', 'premier', 'royal canin', 'hill', 'purina',
      'golden', 'bifinhos', 'petisco pet'
    ]
  },
  {
    id: 'beleza',
    nome: 'Beleza e Cuidados',
    icone: '💅',
    cor: '#C2185B',
    palavras: [
      'salão', 'salao', 'cabeleireiro', 'cabeleireira', 'barbearia', 'barbeiro',
      'corte de cabelo', 'corte cabelo', 'tintura', 'coloração', 'coloracao',
      'escova', 'progressiva', 'botox capilar', 'queratina', 'hidratação capilar',
      'manicure', 'pedicure', 'unha', 'unhas', 'gel', 'acrigel', 'fibra',
      'depilação', 'depilacao', 'cera', 'laser', 'epilação', 'epilacao',
      'maquiagem', 'make', 'cosmético', 'cosmetico', 'base', 'batom',
      'sombra', 'blush', 'contour', 'bronzer', 'iluminador', 'primer',
      'mascara', 'rímel', 'rimel', 'delineador', 'lápis de olho',
      'perfume', 'colônia', 'colonia', 'desodorante', 'hidratante',
      'protetor solar', 'fps', 'creme facial', 'sérum', 'serum', 'tônico',
      'tonico', 'esfoliante', 'máscara facial', 'botox', 'preenchimento',
      'estética', 'estetica', 'massagem', 'spa', 'day spa', 'drenagem',
      'microblading', 'micropigmentação', 'micropigmentacao', 'sobrancelha',
      'extensão de cílios', 'cilios', 'lash', 'remoção', 'limpeza de pele',
      'peeling', 'luz pulsada', 'radiofrequência', 'radiofrequencia',
      'pente', 'pente de cabelo', 'escova de cabelo', 'chapinha', 'babyliss',
      'secador de cabelo', 'lixa de unha', 'esmalte', 'removedor de esmalte',
      'algodão', 'cotonete', 'touca de banho', 'necessaire', 'espelho de mão',
      'pinça', 'alicate de unha'
    ]
  },
  {
    id: 'outros',
    nome: 'Outros',
    icone: '📦',
    cor: '#5F5E5A',
    palavras: []
  }
];

// ─── EXTRATOR DE VALOR ────────────────────────────────────────────────────────
function extractValue(text) {
  const t = text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove acentos para matching

  const patterns = [
    // R$ 1.234,56 ou R$ 1234,56 ou R$ 1234.56
    /r\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/,
    // 1234,56 reais ou 1234.56 reais
    /(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:reais|real|brl)/,
    // reais 1234,56
    /(?:reais|real|brl)\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/,
    // valor isolado com vírgula (ex: 87,50)
    /\b(\d{1,4},\d{2})\b/,
    // valor isolado com ponto decimal (ex: 87.50)
    /\b(\d{1,4}\.\d{2})\b/,
    // valor inteiro solto no final ou sozinho (ex: "uber 23")
    /\b(\d{1,5})\b(?!\s*(?:\/|\d|h|min|km|%|°))/,
  ];

  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match) {
      let raw = match[1].replace(/\./g, '').replace(',', '.');
      const val = parseFloat(raw);
      if (!isNaN(val) && val > 0 && val < 100000) return val;
    }
  }
  return null;
}

// ─── EXTRATOR DE DESCRIÇÃO ────────────────────────────────────────────────────
function extractDescription(text) {
  // Remove valor monetário para deixar só a descrição
  let desc = text
    .replace(/r\$\s*[\d.,]+/gi, '')
    .replace(/[\d.,]+\s*reais/gi, '')
    .replace(/reais\s*[\d.,]+/gi, '')
    .replace(/[\d.,]+\s*real/gi, '')
    .replace(/\b\d{1,5}[.,]\d{2}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Capitaliza
  if (desc.length > 0) {
    desc = desc.charAt(0).toUpperCase() + desc.slice(1);
  }

  return desc.length > 2 ? desc.slice(0, 50) : text.slice(0, 50);
}

// ─── CLASSIFICADOR PRINCIPAL ──────────────────────────────────────────────────
function classify(text, customCategories = [], baseCategories = null) {
  if (!text || text.trim().length === 0) return null;

  const src = baseCategories || DEFAULT_CATEGORIES;
  const allCategories = src.map(c => ({ ...c, palavras: [...c.palavras] }));

  // Mapa: palavra normalizada → id da categoria default que a contém
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const defaultOwner = new Map();
  for (const cat of (baseCategories || DEFAULT_CATEGORIES)) {
    for (const w of cat.palavras) {
      const nw = norm(w);
      if (!defaultOwner.has(nw)) defaultOwner.set(nw, cat.id);
    }
  }

  // Mescla categorias customizadas — adiciona palavras às existentes ou cria novas.
  // Palavras já atribuídas a outra categoria default são ignoradas para evitar
  // que dados antigos do localStorage corrompam a classificação.
  for (const custom of customCategories) {
    const existing = allCategories.find(c => c.id === custom.id);
    if (existing) {
      const safeWords = custom.palavras.filter(w => {
        const owner = defaultOwner.get(norm(w));
        return !owner || owner === custom.id;
      });
      existing.palavras = [...new Set([...existing.palavras, ...safeWords])];
    } else {
      allCategories.push(custom);
    }
  }

  const normalized = text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  let bestCategory = null;
  let bestScore = 0;

  for (const cat of allCategories) {
    if (cat.id === 'outros') continue;
    let score = 0;
    const seen = new Set();
    for (const word of cat.palavras) {
      const normalizedWord = word.toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (seen.has(normalizedWord)) continue; // ignora variantes duplicadas (ex: oculos/oculos)
      seen.add(normalizedWord);
      if (normalized.includes(normalizedWord)) {
        // Palavras mais longas = mais específicas = peso maior
        score += normalizedWord.length > 6 ? 3 : normalizedWord.length > 3 ? 2 : 1;
      }
    }
    if (score >= bestScore) {
      bestScore = score;
      bestCategory = cat;
    }
  }

  const valor = extractValue(text);
  const descricao = extractDescription(text);
  const categoria = bestCategory || allCategories.find(c => c.id === 'outros');

  return {
    descricao,
    valor,
    categoria: categoria.nome,
    categoriaId: categoria.id,
    icone: categoria.icone,
    cor: categoria.cor,
    confianca: bestScore > 0 ? Math.min(100, bestScore * 10) : 0
  };
}

// Exporta para uso no renderer
if (typeof module !== 'undefined') module.exports = { classify, extractValue, DEFAULT_CATEGORIES };
