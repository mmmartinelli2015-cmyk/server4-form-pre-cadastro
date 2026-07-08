import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const PORT = process.env.PORT || 3003;

// ======================= ENV ENVISION =======================
const ENVISION_BASE_URL                        = process.env.ENVISION_BASE_URL || 'https://api.travelagent.com.br';
const ENVISION_USERNAME                        = process.env.ENVISION_USERNAME;
const ENVISION_PASSWORD                        = process.env.ENVISION_PASSWORD;
const ENVISION_FORM_ENDPOINT                   = process.env.ENVISION_FORM_ENDPOINT || '/Records';
const ENVISION_CONSOLIDATOR_ID                 = Number(process.env.ENVISION_CONSOLIDATOR_ID || 0);
const ENVISION_CONSOLIDATOR_SYSTEM_ACCOUNT_ID  = Number(process.env.ENVISION_CONSOLIDATOR_SYSTEM_ACCOUNT_ID || 0);
const ENVISION_TRAVEL_AGENCY_ID                = Number(process.env.ENVISION_TRAVEL_AGENCY_ID || 0);
const ENVISION_TRAVEL_AGENCY_SYSTEM_ACCOUNT_ID = Number(process.env.ENVISION_TRAVEL_AGENCY_SYSTEM_ACCOUNT_ID || 0);
const ENVISION_SYSTEM_ACCOUNT_ID               = Number(process.env.ENVISION_SYSTEM_ACCOUNT_ID || 0);
const ENVISION_RECORD_TYPE                     = process.env.ENVISION_RECORD_TYPE || 'Person';

// ======================= HELPERS =======================
function safeString(value = '') {
  return String(value ?? '').trim();
}

function onlyDigits(value = '') {
  return String(value || '').replace(/\D/g, '');
}

function removeEmptyDeep(obj) {
  if (Array.isArray(obj)) {
    return obj.map(removeEmptyDeep).filter(
      (item) =>
        item !== '' &&
        item !== null &&
        item !== undefined &&
        !(typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0)
    );
  }
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      const cleaned = removeEmptyDeep(value);
      const isEmptyObject =
        cleaned &&
        typeof cleaned === 'object' &&
        !Array.isArray(cleaned) &&
        Object.keys(cleaned).length === 0;
      if (cleaned === '' || cleaned === null || cleaned === undefined || isEmptyObject) continue;
      out[key] = cleaned;
    }
    return out;
  }
  return obj;
}

function parseDateParts(value = '') {
  const v = safeString(value);
  if (!v) return undefined;
  let year, month, day;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    [year, month, day] = v.split('-').map(Number);
  } else {
    const br = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!br) return undefined;
    day = Number(br[1]);
    month = Number(br[2]);
    year = Number(br[3]);
  }
  if (!year || !month || !day) return undefined;
  return { year, month, day };
}

function splitName(fullName = '') {
  const parts = safeString(fullName).split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    middleName: '',
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : ''
  };
}

// ======================= NORMALIZACAO =======================
function normalizeWebhookPayload(body = {}) {
  return {
    nomeCompleto:   safeString(body.nomeCompleto || body.name || body.nome || ''),
    telefone:       safeString(body.telefone || body.telefoneCelular || body.mobile_phone || body.personal_phone || ''),
    cpf:            safeString(body.cpf || body.cf_infos_pessoais_cpf || ''),
    dataNascimento: safeString(body.dataNascimento || body.cf_data_de_nascimento || ''),
    email:          safeString(body.email || ''),
    endereco:       safeString(body.endereco || body.cf_endereco || '')
  };
}

// ======================= TOKEN =======================
async function getEnvisionToken() {
  if (!ENVISION_USERNAME || !ENVISION_PASSWORD) {
    throw new Error('ENVISION_USERNAME ou ENVISION_PASSWORD nao configurados no .env');
  }
  const url = `${ENVISION_BASE_URL}/token`;
  const body = new URLSearchParams();
  body.append('grant_type', 'password');
  body.append('username', ENVISION_USERNAME);
  body.append('password', ENVISION_PASSWORD);

  console.log('>> Solicitando token ao Envision em:', url);

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const text = await resp.text();
  console.log('>> Resposta /token Envision:', resp.status);

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!resp.ok) throw new Error(`Falha ao obter token do Envision: ${resp.status} ${text}`);
  if (!data.access_token) throw new Error('Resposta do Envision nao contem access_token');

  return data.access_token;
}

// ======================= BUILD PAYLOAD =======================
function buildEnvisionRecordPayload(formData, existingId = null) {
  const nomeCompleto   = safeString(formData.nomeCompleto);
  const email          = safeString(formData.email);
  const cpf            = safeString(formData.cpf);
  const telefone       = safeString(formData.telefone);
  const dataNascimento = safeString(formData.dataNascimento);
  const endereco       = safeString(formData.endereco);

  const { firstName, middleName, lastName } = splitName(nomeCompleto);

  const identification = cpf || email || `lead-${Date.now()}`;
  const summary        = `${nomeCompleto || 'Lead sem nome'} - Person Record`;

  const documents = [];
  if (cpf) {
    documents.push({
      Type: '2',
      TypeName: 'CPF',
      FullName: nomeCompleto || firstName || email,
      Number: cpf,
      Country: 'BR',
      CountryName: 'Brasil',
      ExpireDate: {
        year: 2099, month: 1, day: 1, dayOfWeek: 'thursday',
        hour: 0, minutes: 0, seconds: 0, millisecond: 0
      }
    });
  }

  const addresses = [];
  if (endereco) {
    addresses.push({
      Type: '0',
      TypeName: 'Residencial',
      ZipCode: '',
      Street: endereco,
      Number: '',
      Complement: '',
      Neighborhood: '',
      City: '',
      State: '',
      Country: 'Brasil'
    });
  }

  const record = {
    ...(existingId ? { id: existingId } : {}),
    type:            ENVISION_RECORD_TYPE,
    systemAccountId: ENVISION_SYSTEM_ACCOUNT_ID,
    travelAgencyId:  ENVISION_TRAVEL_AGENCY_ID,
    active:          true,
    identification,
    summary,
    externalId:      cpf.replace(/\D/g, '') || email,
    firstName:       firstName,
    middleName:      middleName || undefined,
    lastName:        lastName || undefined,
    fullName:        nomeCompleto || undefined,
    email,
    phone:           telefone,
    birthDate:       parseDateParts(dataNascimento),
    adress:          endereco || undefined,
    documents,
    addresses,
    permissions: {
      edit: true,
      onlineRetrieve: true
    }
  };

  return removeEmptyDeep({
    companyContext: {
      consolidator: {
        id: ENVISION_CONSOLIDATOR_ID,
        systemAccountId: ENVISION_CONSOLIDATOR_SYSTEM_ACCOUNT_ID
      },
      travelAgency: {
        id: ENVISION_TRAVEL_AGENCY_ID,
        systemAccountId: ENVISION_TRAVEL_AGENCY_SYSTEM_ACCOUNT_ID
      }
    },
    record
  });
}

// ======================= LOOKUP POR EXTERNALID =======================
async function findRecordIdByExternalId(token, cpf, email) {
  const cpfDigits = onlyDigits(cpf);
  const candidates = [...new Set([cpfDigits, cpf, email].filter(Boolean))];

  for (const candidate of candidates) {
    try {
      const url = `${ENVISION_BASE_URL}/Records/Query`;
      const body = {
        criteria: `externalId = "${candidate}"`,
        sortFields: [],
        pagingPivotId: 0,
        pagingPivotValues: [],
        additionalInfo: {
          travelAgencyId: ENVISION_TRAVEL_AGENCY_ID,
          systemAccountId: ENVISION_SYSTEM_ACCOUNT_ID
        }
      };

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body)
      });

      const text = await resp.text();
      console.log(`[Envision] Records/Query (${candidate}) status: ${resp.status}`);

      let data;
      try { data = JSON.parse(text); } catch { data = null; }

      if (resp.ok && data?.successful !== false) {
        const records = Array.isArray(data?.records) ? data.records : [];
        if (records[0]?.id) return records[0].id;
      }
    } catch (err) {
      console.warn(`[Envision] Erro Records/Query (${candidate}):`, err.message);
    }
  }
  return null;
}

// ======================= ENVIO (UPSERT) =======================
async function sendFormToEnvision(formData, attempt = 1) {
  console.log(`>> Enviando ao Envision (tentativa ${attempt})...`);

  const token = await getEnvisionToken();
  const cpf   = safeString(formData.cpf);
  const email = safeString(formData.email);

  const existingId = await findRecordIdByExternalId(token, cpf, email);
  if (existingId) {
    console.log(`[Envision] Registro existente encontrado (externalId). ID: ${existingId}. POST com id para atualizar...`);
  } else {
    console.log('[Envision] Nenhum registro encontrado. Criando novo...');
  }

  const url     = `${ENVISION_BASE_URL}${ENVISION_FORM_ENDPOINT}`;
  const payload = buildEnvisionRecordPayload(formData, existingId);

  console.log('>> URL Envision:', url);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    console.log('>> Resposta Envision:', resp.status);

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!resp.ok) {
      throw new Error(`Erro ao enviar dados ao Envision Records: ${resp.status} ${text}`);
    }

    return { action: existingId ? 'updated' : 'created', ...data };
  } catch (err) {
    if ((err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') && attempt < 3) {
      console.warn(`>> ECONNRESET/TIMEOUT - aguardando 2s e tentando novamente (${attempt}/3)...`);
      await new Promise(r => setTimeout(r, 2000));
      return sendFormToEnvision(formData, attempt + 1);
    }
    throw err;
  }
}

// ======================= ROTAS =======================
app.get('/', (req, res) => {
  return res.send('Servidor server4 (cadastro inicial) online.');
});

app.get('/health', (req, res) => {
  return res.status(200).json({ status: 'ok', service: 'server4' });
});

app.post('/rdstation-webhook', async (req, res) => {
  try {
    console.log('\n>> [server4] /rdstation-webhook recebido');

    const formData = normalizeWebhookPayload(req.body);
    console.log('>> formData normalizado:', formData);

    if (!formData.nomeCompleto || !formData.email) {
      console.warn('>> Campos obrigatorios ausentes (nomeCompleto, email).');
      return res.status(200).json({
        success: false,
        error: 'Campos obrigatorios ausentes: nomeCompleto, email.',
        normalized: formData
      });
    }

    const envisionResult = await sendFormToEnvision(formData);

    return res.status(200).json({
      success: true,
      message: 'Dados enviados ao Envision Records Person com sucesso.',
      normalized: formData,
      envision: envisionResult
    });
  } catch (err) {
    console.error('>> Erro em /rdstation-webhook:', err);
    return res.status(200).json({
      success: false,
      error: 'Erro ao integrar com Envision Records',
      detail: err.message
    });
  }
});

app.post('/envisionform', async (req, res) => {
  try {
    console.log('\n>> [server4] /envisionform recebido');

    const formData = normalizeWebhookPayload(req.body);
    console.log('>> formData normalizado:', formData);

    if (!formData.nomeCompleto || !formData.email) {
      return res.status(400).json({
        success: false,
        error: 'Campos obrigatorios ausentes: nomeCompleto, email.',
        normalized: formData
      });
    }

    const envisionResult = await sendFormToEnvision(formData);

    return res.status(200).json({
      success: true,
      message: 'Dados enviados ao Envision Records Person com sucesso.',
      normalized: formData,
      envision: envisionResult
    });
  } catch (err) {
    console.error('>> Erro em /envisionform:', err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ======================= START =======================
app.listen(PORT, () => {
  console.log(`✅ server4 (cadastro inicial) rodando na porta ${PORT}`);
});
