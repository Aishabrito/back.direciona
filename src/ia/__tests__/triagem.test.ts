import { describe, it, expect } from 'vitest';
import { extrairInformacoes } from '../extrator_de_informacoes.js';
import { aplicarMotor } from '../motor_de_regras.js';
import { classificarNivel } from '../sinais_criticos.js';
import { mensagemPorId } from '../mensagens.js';

// Helper: roda o pipeline completo (extrai + motor) e devolve a decisão.
function decidir(texto: string) {
  const relato = extrairInformacoes(texto);
  return aplicarMotor(relato, texto);
}

// ═══════════════════════════════════════════════════════════
// 1. EMERGÊNCIAS CLÁSSICAS → SAMU
// ═══════════════════════════════════════════════════════════
describe('emergências → SAMU', () => {
  it('falta de ar + dor no peito → emergencia_001', () => {
    const d = decidir('estou com falta de ar e dor no peito');
    expect(d.resposta_id).toBe('emergencia_001');
    expect(d.nivel).toBe('SAMU_AGORA');
  });

  it('dor no peito com falta de ar → SAMU', () => {
    const d = decidir('dor no peito com falta de ar e suor frio');
    expect(d.nivel).toBe('SAMU_AGORA');
  });

  it('não consigo respirar → SAMU', () => {
    const d = decidir('não consigo respirar');
    expect(d.nivel).toBe('SAMU_AGORA');
    expect(d.resposta_id).toBe('emergencia_001');
  });

  it('AVC (boca torta + fala enrolada) → SAMU', () => {
    const d = decidir('meu pai está com a boca torta e fala enrolada');
    expect(d.resposta_id).toBe('emergencia_001');
    expect(d.nivel).toBe('SAMU_AGORA');
  });

  it('autodiagnóstico de infarto → SAMU', () => {
    const d = decidir('acho que estou tendo um infarto');
    expect(d.nivel).toBe('SAMU_AGORA');
  });

  it('convulsão → SAMU', () => {
    const d = decidir('meu filho teve uma convulsão');
    expect(d.nivel).toBe('SAMU_AGORA');
    expect(d.resposta_id).toBe('emergencia_001');
  });

  it('trauma penetrante (esfaqueado) → SAMU', () => {
    const d = decidir('meu irmão foi esfaqueado');
    expect(d.resposta_id).toBe('emergencia_001');
    expect(d.nivel).toBe('SAMU_AGORA');
  });

  it('bebê com febre → pediatria_emergencia_001', () => {
    const d = decidir('meu bebê está com febre');
    expect(d.resposta_id).toBe('pediatria_emergencia_001');
    expect(d.nivel).toBe('SAMU_AGORA');
  });

  it('risco mental iminente → SAMU', () => {
    const d = decidir('não quero mais viver');
    expect(d.resposta_id).toBe('mental_emergencia_001');
    expect(d.nivel).toBe('SAMU_AGORA');
  });

  it('violência doméstica → SAMU', () => {
    const d = decidir('meu marido me agrediu');
    expect(d.nivel).toBe('SAMU_AGORA');
  });

  it('idoso caiu e está confuso → SAMU', () => {
    const d = decidir('meu avô de 80 anos caiu e está confuso');
    expect(d.nivel).toBe('SAMU_AGORA');
  });

  it('queimadura extensa → SAMU', () => {
    const d = decidir('me queimei com água fervendo, foi uma queimadura extensa');
    expect(d.nivel).toBe('SAMU_AGORA');
  });
});

// ═══════════════════════════════════════════════════════════
// 2. FALSOS POSITIVOS CONHECIDOS
// ═══════════════════════════════════════════════════════════
describe('falsos positivos de emergência', () => {
  it('"o que é AVC?" → informacao_insuficiente', () => {
    const r = extrairInformacoes('o que é AVC?');
    expect(r.informacao_insuficiente).toBe(true);
    expect(r.autodiagnostico_grave).toBe(null);
    expect(r.sinais_neurologicos.length).toBe(0);
  });

  it('"o que é infarto?" → não dispara SAMU', () => {
    const r = extrairInformacoes('o que é infarto?');
    expect(r.autodiagnostico_grave).toBe(null);
  });

  it('"oq e caps" → não vira saúde mental', () => {
    const r = extrairInformacoes('oq e caps');
    expect(r.risco_mental).toBe('nao_mencionado');
  });

  it('"diferença entre UPA e UBS" → não é sintoma', () => {
    const r = extrairInformacoes('qual a diferença entre UPA e UBS?');
    expect(r.informacao_insuficiente).toBe(true);
  });

  it('"me cortei com a faca cozinhando" → NÃO é trauma penetrante', () => {
    const r = extrairInformacoes('me cortei com a faca cozinhando');
    expect(r.sinais_trauma).not.toContain('ferimento_perfurante');
  });

  it('"vim de carro" → não é trauma automobilístico', () => {
    const r = extrairInformacoes('estou com tosse, vim de carro');
    expect(r.sinais_trauma).not.toContain('trauma_automobilistico');
  });

  it('"não bebo água" → não é bebê', () => {
    const r = extrairInformacoes('meu pai não bebe água');
    expect(r.idade_grupo).not.toBe('bebe');
  });

  it('"problema na tiroide" → não é ferimento por arma', () => {
    const r = extrairInformacoes('tenho problema na tiroide');
    expect(r.sinais_trauma).not.toContain('ferimento_perfurante');
  });
});

// ═══════════════════════════════════════════════════════════
// 3. FEBRE PERSISTENTE (bug que voltou 3x) → UPA
// ═══════════════════════════════════════════════════════════
describe('febre persistente', () => {
  it('febre há 3 dias → UPA, não UBS', () => {
    const d = decidir('estou com febre há 3 dias');
    expect(d.resposta_id).toBe('upa_001');
    expect(d.nivel).toBe('HOJE');
  });

  it('febre há 5 dias → UPA', () => {
    const d = decidir('febre há 5 dias');
    expect(d.resposta_id).toBe('upa_001');
  });

  it('febre há uma semana → UPA', () => {
    const d = decidir('estou com febre há uma semana');
    expect(d.resposta_id).toBe('upa_001');
  });

  it('febre + prostração → UPA', () => {
    const d = decidir('estou com febre e muita fraqueza');
    expect(d.resposta_id).toBe('upa_001');
  });
});

// ═══════════════════════════════════════════════════════════
// 4. NEGAÇÃO
// ═══════════════════════════════════════════════════════════
describe('negação', () => {
  it('"não tenho falta de ar" → falta_de_ar não é true', () => {
    const r = extrairInformacoes('não tenho falta de ar');
    expect(r.falta_de_ar).not.toBe(true);
  });

  it('"sem febre mas com dor no peito" → dor_no_peito=true', () => {
    const r = extrairInformacoes('sem febre mas com dor no peito');
    expect(r.dor_no_peito).toBe(true);
    expect(r.febre).not.toBe(true);
  });

  it('"não tenho febre, só dor no peito" → idem', () => {
    const r = extrairInformacoes('não tenho febre, só dor no peito');
    expect(r.dor_no_peito).toBe(true);
    expect(r.febre).not.toBe(true);
  });

  it('"não estou grávida" → gestante=nao', () => {
    const r = extrairInformacoes('estou com dor nas costas mas não estou grávida');
    expect(r.gestante).toBe('nao');
  });
});

// ═══════════════════════════════════════════════════════════
// 5. TERCEIROS
// ═══════════════════════════════════════════════════════════
describe('terceiros', () => {
  it('"minha mãe caiu" → relato_sobre_terceiro=true', () => {
    const r = extrairInformacoes('minha mãe caiu e bateu a cabeça');
    expect(r.relato_sobre_terceiro).toBe(true);
    expect(r.pessoa).toBe('mãe');
  });

  it('"meu filho está com febre" → filho', () => {
    const r = extrairInformacoes('meu filho está com febre');
    expect(r.relato_sobre_terceiro).toBe(true);
    expect(r.pessoa).toBe('filho');
  });

  it('"minha avó está confusa" → avó', () => {
    const r = extrairInformacoes('minha avó está confusa');
    expect(r.relato_sobre_terceiro).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. DENGUE / VIOLÊNCIA / ODONTOLOGIA / DESIDRATAÇÃO
// ═══════════════════════════════════════════════════════════
describe('regras específicas', () => {
  it('febre + dor no corpo + manchas → dengue → UPA', () => {
    const d = decidir('estou com febre, dor no corpo e manchas vermelhas na pele');
    expect(d.resposta_id).toBe('dengue_001');
    expect(d.categoria_interna).toBe('urgencia');
  });

  it('"estou com dengue" → dengue_001', () => {
    const d = decidir('acho que estou com dengue');
    expect(d.resposta_id).toBe('dengue_001');
  });

  it('"meu marido me bateu" → violência → SAMU', () => {
    const d = decidir('meu marido me bateu');
    expect(d.resposta_id).toBe('violencia_001');
    expect(d.nivel).toBe('SAMU_AGORA');
  });

  it('"fui abusada" → violência sexual → SAMU', () => {
    const d = decidir('fui abusada sexualmente');
    expect(d.resposta_id).toBe('violencia_001');
  });

  it('"dor de dente" → odontologia → UBS', () => {
    const d = decidir('estou com dor de dente');
    expect(d.resposta_id).toBe('odontologia_001');
    expect(d.categoria_interna).toBe('baixa_gravidade');
  });

  it('"olhos fundos e boca seca" → desidratação → UPA', () => {
    const d = decidir('meu filho está com olhos fundos e boca seca');
    expect(d.resposta_id).toBe('desidratacao_001');
  });

  it('"tomei 2 cartelas de remédio" → intoxicação grave → SAMU', () => {
    const d = decidir('tomei 2 cartelas de paracetamol');
    expect(d.nivel).toBe('SAMU_AGORA');
  });
});

// ═══════════════════════════════════════════════════════════
// 7. CLASSIFICAÇÃO DE NÍVEL
// ═══════════════════════════════════════════════════════════
describe('classificarNivel', () => {
  it('emergência → crítico', () => {
    const r = extrairInformacoes('não consigo respirar');
    expect(classificarNivel(r)).toBe('critico');
  });

  it('falta de ar sem qualificador → alerta', () => {
    const r = extrairInformacoes('estou com falta de ar');
    expect(classificarNivel(r)).toBe('alerta');
  });

  it('sintoma leve → normal', () => {
    const r = extrairInformacoes('estou com coriza há 2 dias');
    expect(classificarNivel(r)).toBe('normal');
  });
});

// ═══════════════════════════════════════════════════════════
// 8. FUZZ — entradas degeneradas
// ═══════════════════════════════════════════════════════════
describe('entradas degeneradas', () => {
  it('string vazia não quebra', () => {
    expect(() => extrairInformacoes('')).not.toThrow();
  });

  it('só emojis → informação insuficiente', () => {
    const r = extrairInformacoes('😀😀😀');
    expect(r.informacao_insuficiente).toBe(true);
  });

  it('lixo aleatório → informação insuficiente', () => {
    const r = extrairInformacoes('asdfghjkl');
    expect(r.informacao_insuficiente).toBe(true);
  });

  it('"oi" → informação insuficiente', () => {
    const r = extrairInformacoes('oi');
    expect(r.informacao_insuficiente).toBe(true);
  });

  it('texto longo sem sentido → não quebra', () => {
    expect(() => extrairInformacoes('a '.repeat(500))).not.toThrow();
  });

  it('pontuação excessiva não quebra', () => {
    expect(() => extrairInformacoes('dor... no... peito...,,,;;;')).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// 9. MENSAGENS APROVADAS
// ═══════════════════════════════════════════════════════════
describe('mensagens aprovadas', () => {
  const idsNecessarios = [
    'emergencia_001', 'upa_001', 'ubs_001', 'fallback_001',
    'pediatria_emergencia_001', 'obstetricia_001', 'mental_emergencia_001',
    'mental_caps_001', 'violencia_001', 'dengue_001', 'desidratacao_001',
    'intoxicacao_001', 'odontologia_001', 'encerramento_001',
    'novo_caso_001', 'privacidade_001', 'foto_sem_legenda_001',
  ];

  for (const id of idsNecessarios) {
    it(`mensagem ${id} existe`, () => {
      const m = mensagemPorId(id);
      expect(m.id).toBe(id);
      expect(m.texto.length).toBeGreaterThan(10);
    });
  }
});