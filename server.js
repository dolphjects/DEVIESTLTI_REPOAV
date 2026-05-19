const express = require('express');
const dotenv = require('dotenv');
dotenv.config();
const axios = require('axios');
const { stringify } = require('csv-stringify/sync');
const pLimit = require('p-limit').default;
const path = require('path');
const LtiProvider = require('ltijs').Provider;

const {
  PORT = 3000,
  PLATFORM_URL,
  AUTH_LOGIN_URL,
  AUTH_TOKEN_URL,
  KEYSET_URL,
  TOOL_URL,
  LTI_ENCRYPTION_KEY,
  CANVAS_TOKEN,
  CLIENT_ID,
  MONGO_URL,
  NODE_ENV 
} = process.env;

// --- Configuración Axios ---
const canvas = axios.create({
  baseURL: `${PLATFORM_URL}/api/v1`,
  headers: { Authorization: `Bearer ${CANVAS_TOKEN || ''}` }
});

// --- Helpers de Paginación y Datos ---
async function getAll(url, params = {}) {
  let out = [];
  let next = url;
  let cfg = { params: { per_page: 100, ...params } };
  while (next) {
    const r = await canvas.get(next, cfg);
    out = out.concat(r.data);
    next = null;
    const link = r.headers.link;
    if (link) {
      for (const part of link.split(',')) {
        if (part.includes('rel="next"')) {
          next = part.substring(part.indexOf('<') + 1, part.indexOf('>'))
            .replace(`${PLATFORM_URL}/api/v1`, '');
        }
      }
    }
    cfg = {};
  }
  return out;
}

async function getStudents(courseId) {
  const list = await getAll(`/courses/${courseId}/enrollments`, {
    'type[]': 'StudentEnrollment',
    'state[]': 'active'
  });
  return list.map(e => ({ id: e.user.id, name: e.user.name, sis_user_id: e.user.sis_id || e.sis_user_id }));
}

async function getModulesForStudent(courseId, studentId) {
  return getAll(`/courses/${courseId}/modules`, {
    'include[]': ['items', 'content_details'],
    student_id: studentId
  });
}

// --- Lógica de Negocio (Reporte Profesor) ---
async function generateReportData(courseId) {
  if (!CANVAS_TOKEN) throw new Error('Falta CANVAS_TOKEN');
  
  const students = await getStudents(courseId);
  const limit = pLimit(8);
  
  const studentData = await Promise.all(
    students.map(s =>
      limit(async () => {
        try {
          const mods = await getModulesForStudent(courseId, s.id);
          const rows = [];
          for (const m of mods) {
            if (m.name === 'Programa del Curso') continue; 
            const items = m.items || [];
            const reqItems = items.filter(i => !!i.completion_requirement);
            const done = reqItems.filter(i => i.completion_requirement.completed).length;
            const pct = reqItems.length ? Math.round((100 * done) / reqItems.length) : 0;

            rows.push({
              type: 'summary',
              student_id: s.id,
              student_name: s.name,
              sis_user_id: s.sis_user_id,
              module_id: m.id,
              module_name: m.name,
              module_state: m.state,
              module_pct: pct
            });

            for (const it of items) {
              rows.push({
                type: 'detail',
                student_id: s.id,
                student_name: s.name,
                sis_user_id: s.sis_user_id,
                module_id: m.id,
                module_name: m.name,
                item_id: it.id,
                item_title: it.title,
                item_type: it.type,
                requirement_type: it.completion_requirement?.type || null,
                completed: it.completion_requirement?.completed ?? null,
                due_at: it.content_details?.due_at || null,
                html_url: it.html_url || null
              });
            }
          }
          return rows;
        } catch (e) { return []; }
      })
    )
  );

  const flat = studentData.flat();
  const summaryRows = flat.filter(r => r.type === 'summary');
  const detailRows = flat.filter(r => r.type === 'detail');

  const studentsMap = new Map();
  const modulesMap = new Map();
  const matrix = {};
  let moduleCounter = 0;

  for (const row of summaryRows) {
    if (!studentsMap.has(row.student_id)) {
      studentsMap.set(row.student_id, {
        id: row.student_id,
        name: row.student_name,
        sis_user_id: row.sis_user_id || row.student_id
      });
    }
    if (!modulesMap.has(row.module_id)) {
      modulesMap.set(row.module_id, {
        id: row.module_id,
        name: row.module_name,
        short_name: `Módulo ${moduleCounter++}`
      });
    }
    matrix[`${row.student_id}_${row.module_id}`] = `${row.module_pct}%`; 
  }

  const studentsList = Array.from(studentsMap.values()).sort((a, b) => 
    (a.sis_user_id || '').localeCompare(b.sis_user_id || '', undefined, { numeric: true })
  );
  const modulesList = Array.from(modulesMap.values());
  const csvReportData = [];

  for (const s of studentsList) {
    const csvRow = { 'ID IEST': s.sis_user_id, 'Nombre': s.name };
    for (const m of modulesList) {
      csvRow[m.short_name] = matrix[`${s.id}_${m.id}`] || '-';
    }
    csvReportData.push(csvRow);
  }

  return {
    summary: summaryRows,
    detail: detailRows,
    csv: stringify(csvReportData, { header: true, bom: true })
  };
}

// --- Configuración LTI ---
const web = express();
web.set('views', path.join(__dirname, 'views'));
web.use(express.urlencoded({ extended: true }));
web.use(express.json());

const lti = LtiProvider; 

lti.setup(
  LTI_ENCRYPTION_KEY,
  { url: MONGO_URL },
  { 
    appRoute: '/lti',
    loginRoute: '/login',
    keysetRoute: '/keys',
    devMode: false, 
    cookies: { secure: true, sameSite: 'None' }
  }
);

lti.whitelist(
  '/', 
  '/canvas-courses', 
  '/course-details', 
  '/report', 
  '/report/data', 
  '/api/process-report',
  '/api/get-real-role', 
  '/api/coordinator-report',
  '/css', 
  '/js', 
  '/img'
);

// --- Rutas de Vistas ---
web.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'selector.html')); });
web.get('/report', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'index.html')); });

// --- Rutas API: Profesor ---
web.get('/api/process-report', async (req, res) => {
  const { course_id } = req.query;
  if (!course_id) return res.status(400).json({ error: 'Falta course_id' });
  try {
    const data = await generateReportData(course_id);
    res.json({ summary: data.summary, detail: data.detail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Rutas API: Detección de Rol Real ---
web.get('/api/get-real-role', async (req, res) => {
  const { course_id, user_id } = req.query;
  if (!course_id || !user_id) return res.status(400).json({ error: 'Faltan datos' });
  if (!CANVAS_TOKEN) return res.status(500).json({ error: 'Falta Token' });

  try {
    const baseUrl = PLATFORM_URL.endsWith('/') ? PLATFORM_URL.slice(0, -1) : PLATFORM_URL;
    const response = await axios.get(`${baseUrl}/api/v1/courses/${course_id}/enrollments`, {
      headers: { Authorization: `Bearer ${CANVAS_TOKEN}` },
      params: { user_id: user_id }
    });

    const enrollments = response.data;
    if (enrollments && enrollments.length > 0) {
      const custom = enrollments.find(e => e.role !== e.type);
      if (custom) {
        console.log(`✅ Rol Personalizado: ${custom.role} (User: ${user_id})`);
        return res.json({ role: custom.role });
      }
      console.log(`ℹ️ Rol Estándar: ${enrollments[0].role} (User: ${user_id})`);
      return res.json({ role: enrollments[0].role });
    }

    console.log(`⚠️ Sin inscripciones para User: ${user_id}`);
    return res.json({ role: null });

  } catch (error) {
    console.error('❌ Error buscando rol:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- Rutas API: Reporte Coordinador ---
web.get('/api/coordinator-report', async (req, res) => {
  const { course_id } = req.query;
  if (!course_id || !CANVAS_TOKEN) return res.status(400).json({ error: 'Datos incompletos' });

  try {
    const baseUrl = PLATFORM_URL.endsWith('/') ? PLATFORM_URL.slice(0, -1) : PLATFORM_URL;
    const headers = { Authorization: `Bearer ${CANVAS_TOKEN}` };

    console.log(`📋 Generando reporte Coordinador para curso: ${course_id}`);

    // A. Datos Maestro
    const teachersRes = await axios.get(`${baseUrl}/api/v1/courses/${course_id}/enrollments`, {
      headers,
      params: { type: ['TeacherEnrollment'] }
    });
    const teacher = teachersRes.data[0] || null;
    const teacherData = {
        name: teacher ? teacher.user.name : 'No asignado',
        last_login: teacher ? teacher.last_activity_at : null,
        total_seconds: teacher ? teacher.total_activity_time : 0
    };

    // B. Total Alumnos Activos
    const studentsEnrollments = await axios.get(`${baseUrl}/api/v1/courses/${course_id}/enrollments`, {
        headers,
        params: { type: ['StudentEnrollment'], state: ['active'], per_page: 100 }
    });
    const totalStudents = studentsEnrollments.data.length;

    // C. Tareas y Exámenes
    const assignmentsRes = await axios.get(`${baseUrl}/api/v1/courses/${course_id}/assignments`, {
        headers,
        params: { per_page: 50, order_by: 'due_at' }
    });

    const assignments = assignmentsRes.data.map(a => {
        const pending = a.needs_grading_count || 0;
        const graded_approx = Math.max(0, totalStudents - pending); 
        let typeLabel = 'Tarea';
        if (a.quiz_id) typeLabel = 'Examen';
        else if (a.submission_types.includes('discussion_topic')) typeLabel = 'Foro';

        return {
            title: a.name,
            type: typeLabel,
            due_at: a.lock_at || a.due_at,
            needs_grading: pending,
            graded: graded_approx,
            total_students: totalStudents
        };
    });

    res.json({ teacher: teacherData, total_students: totalStudents, assignments: assignments });

  } catch (error) {
    console.error('❌ Error reporte coordinador:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- Rutas API: Auxiliares (CSV, Detalles) ---
web.get('/report/data', async (req, res) => {
  const { kind, course_id } = req.query;
  if (!course_id) return res.status(400).send('Falta course_id');
  
  const cacheKey = `csv_${course_id}`;
  if (kind === 'csv' && web.locals[cacheKey]) {
     res.setHeader('Content-Type', 'text/csv; charset=utf-8'); 
     res.setHeader('Content-Disposition', 'attachment; filename="progreso.csv"');
     return res.send(web.locals[cacheKey]);
  }
  try {
    const data = await generateReportData(course_id);
    if (kind === 'csv') {
      web.locals[cacheKey] = data.csv; 
      res.setHeader('Content-Type', 'text/csv; charset=utf-8'); 
      res.setHeader('Content-Disposition', 'attachment; filename="progreso.csv"');
      return res.send(data.csv);
    }
    res.status(400).send('Solo CSV');
  } catch (e) { res.status(500).send(e.message); }
});

web.get('/canvas-courses', async (req, res) => {
  try {
    if (!CANVAS_TOKEN) throw new Error('Falta CANVAS_TOKEN');
    const baseUrl = PLATFORM_URL.endsWith('/') ? PLATFORM_URL.slice(0, -1) : PLATFORM_URL;
    const response = await axios.get(`${baseUrl}/api/v1/courses`, {
      headers: { Authorization: `Bearer ${CANVAS_TOKEN}` },
      params: { per_page: 100, enrollment_state: 'active', include: ['term'] }
    });
    const cursos = response.data.map(c => ({ id: c.id, nombre: c.name, codigo: c.course_code }));
    res.json({ success: true, total: cursos.length, cursos });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

web.get('/course-details', async (req, res) => {
  const { course_id } = req.query;
  if (!course_id) return res.status(400).json({ error: 'Falta course_id' });
  try {
    const response = await canvas.get(`/courses/${course_id}`);
    res.json({ 
        id: response.data.id, 
        nombre: response.data.name, 
        codigo: response.data.course_code, 
        formato: response.data.course_format || 'No especificado' 
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- Deploy y Lanzamiento LTI ---
(async () => {
  await lti.deploy({ serverless: true, silent: true });

  const posiblesUrls = [
      PLATFORM_URL, 'https://iest.beta.instructure.com', 'https://iest.beta.instructure.com/',
      'https://canvas.instructure.com', 'https://canvas.instructure.com/',
      'https://canvas.beta.instructure.com', 'https://canvas.beta.instructure.com/',
      'https://iest.instructure.com','https://iest.instructure.com/'
  ];

  for (const url of posiblesUrls) {
      if (!url) continue;
      try {
          await lti.registerPlatform({
              url: url,
              name: 'Canvas Variant',
              clientId: CLIENT_ID,
              authenticationEndpoint: AUTH_LOGIN_URL,
              accesstokenEndpoint: AUTH_TOKEN_URL,
              authConfig: { method: 'JWK_SET', key: KEYSET_URL }
          });
      } catch (err) {}
  }

  lti.onConnect(async (token, req, res) => {
    const customContext = token.platformContext.custom;
    const courseId = (customContext && customContext.canvas_course_id) || token.platformContext.context.id;
    const userId = (customContext && customContext.canvas_user_id) || token.user;

    const roles = token.platformContext.roles || [];
    let userRole = 'visitante';
    
    // Mapeo a minúsculas
    if (roles.some(r => r.includes('Administrator'))) userRole = 'admin';
    else if (roles.some(r => r.includes('Instructor'))) userRole = 'profesor';
    else if (roles.some(r => r.includes('Learner') || r.includes('Student'))) userRole = 'estudiante';
    else if (roles.some(r => r.includes('TeachingAssistant'))) userRole = 'auxiliar';

    console.log(`🔗 Launch: Curso ${courseId} | User: ${userId} | Rol: ${userRole}`);

    if (!courseId) return res.status(400).send('No hay contexto de curso.');
    return res.redirect(`/report?course_id=${courseId}&role=${userRole}&user_id=${userId}`);
  });

  const host = express();
  host.enable('trust proxy'); 
  host.use(express.static(path.join(__dirname, 'public')));
  host.use('/', lti.app);
  host.use('/', web);

  host.listen(PORT, () => console.log(`✅ LTI tool corriendo en ${TOOL_URL}`));

})().catch(err => {
  console.error('❌ Error al iniciar la app:', err);
  process.exit(1);
});