'use strict';

const express = require('express');
const dotenv = require('dotenv');
dotenv.config();

const axios = require('axios');
const path = require('path');
const pLimit = require('p-limit').default;
const LtiProvider = require('ltijs').Provider;

const { resolveReportVersion, normalizeVersion } = require('./src/report-version');
const { resolveProgressTiming } = require('./src/progress-timing-provider');

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
  MONGO_URL
} = process.env;

if (!PLATFORM_URL) {
  throw new Error('Falta PLATFORM_URL en las variables de entorno.');
}

const canvas = axios.create({
  baseURL: `${PLATFORM_URL.replace(/\/$/, '')}/api/v1`,
  headers: { Authorization: `Bearer ${CANVAS_TOKEN || ''}` },
  timeout: 30000
});

const accountHierarchyCache = new Map();

const STUDENT_ROLES = new Set([
  'estudiante', 'studentenrollment', 'student', 'learner', 'alumno'
]);

const TEACHER_ROLES = new Set([
  'profesor', 'instructor', 'teacher', 'teacher enrollment',
  'teacherenrollment', 'maestro', 'auxiliar', 'admin', 'administrator', 'visitante'
]);

const REPORT_VIEWS = {
  teacher: {
    basic: 'report-teacher-basic.html',
    pro: 'report-teacher-pro.html'
  },
  student: {
    basic: 'report-student-basic.html',
    pro: 'report-student-pro.html'
  }
};

function normalizeRole(value) {
  const role = String(value || 'teacher').trim().toLowerCase();
  if (STUDENT_ROLES.has(role)) return 'student';
  if (TEACHER_ROLES.has(role)) return 'teacher';
  return 'teacher';
}

/**
 * Resuelve primero los roles enviados en el lanzamiento LTI.
 * Los roles con privilegios de edición tienen prioridad sobre Learner/Student.
 */
function resolveRoleFromLtiRoles(roles = [], fallbackRole = 'teacher') {
  const normalizedRoles = roles.map(role => String(role || '').toLowerCase());

  const hasTeacherRole = normalizedRoles.some(role =>
    role.includes('instructor') ||
    role.includes('administrator') ||
    role.includes('teachingassistant') ||
    role.includes('contentdeveloper') ||
    role.includes('faculty') ||
    role.includes('teacher')
  );

  if (hasTeacherRole) return 'teacher';

  const hasStudentRole = normalizedRoles.some(role =>
    role.includes('learner') || role.includes('student')
  );

  if (hasStudentRole) return 'student';
  return normalizeRole(fallbackRole);
}

/**
 * Consulta las inscripciones del usuario dentro del curso actual.
 * Así evitamos determinar el rol con base en otros cursos del usuario.
 *
 * Prioridad cuando existen varias inscripciones en el mismo curso:
 * Teacher / TA / Designer > Student.
 */
async function resolveRoleForCourse(courseId, userId, options = {}) {
  const {
    ltiRoles = [],
    fallbackRole = 'teacher'
  } = options;

  const fallback = resolveRoleFromLtiRoles(ltiRoles, fallbackRole);

  if (!CANVAS_TOKEN || !courseId || !userId) {
    return fallback;
  }

  try {
    const enrollments = await getAll(
      `/courses/${encodeURIComponent(courseId)}/enrollments`,
      {
        user_id: userId,
        'state[]': ['active', 'invited', 'completed']
      }
    );

    const enrollmentTypes = new Set(
      enrollments.map(enrollment => String(enrollment.type || ''))
    );

    const enrollmentRoles = enrollments
      .flatMap(enrollment => [enrollment.type, enrollment.role])
      .filter(Boolean)
      .map(role => String(role).trim().toLowerCase());

    const hasTeacherEnrollment =
      enrollmentTypes.has('TeacherEnrollment') ||
      enrollmentTypes.has('TaEnrollment') ||
      enrollmentTypes.has('DesignerEnrollment') ||
      enrollmentRoles.some(role =>
        role.includes('teacher') ||
        role.includes('instructor') ||
        role.includes('profesor') ||
        role.includes('maestro') ||
        role.includes('auxiliar') ||
        role.includes('designer')
      );

    if (hasTeacherEnrollment) {
      return 'teacher';
    }

    const hasStudentEnrollment =
      enrollmentTypes.has('StudentEnrollment') ||
      enrollmentTypes.has('StudentViewEnrollment') ||
      enrollmentRoles.some(role =>
        role.includes('student') ||
        role.includes('learner') ||
        role.includes('estudiante') ||
        role.includes('alumno')
      );

    if (hasStudentEnrollment) {
      return 'student';
    }

    console.warn(
      `No se encontró una inscripción reconocida para el usuario ${userId} en el curso ${courseId}. ` +
      `Se utilizará el rol LTI: ${fallback}.`
    );
  } catch (error) {
    console.warn(
      `No se pudo verificar el rol del usuario ${userId} en el curso ${courseId}: ${error.message}. ` +
      `Se utilizará el rol LTI: ${fallback}.`
    );
  }

  return fallback;
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function excludedModuleNames() {
  const configured = String(process.env.EXCLUDED_MODULE_NAMES || '')
    .split(',')
    .map(item => item.trim().toLocaleLowerCase('es-MX'))
    .filter(Boolean);

  return new Set(['programa del curso', ...configured]);
}

function shouldExcludeModule(name) {
  return excludedModuleNames().has(String(name || '').trim().toLocaleLowerCase('es-MX'));
}

async function getAll(url, params = {}) {
  const output = [];
  let next = url;
  let config = { params: { per_page: 100, ...params } };

  while (next) {
    const response = await canvas.get(next, config);
    output.push(...response.data);
    next = null;

    const link = response.headers.link;
    if (link) {
      for (const part of link.split(',')) {
        if (part.includes('rel="next"')) {
          next = part
            .substring(part.indexOf('<') + 1, part.indexOf('>'))
            .replace(`${PLATFORM_URL.replace(/\/$/, '')}/api/v1`, '');
          break;
        }
      }
    }

    config = {};
  }

  return output;
}

async function getAccountHierarchyIds(accountId) {
  const initialId = String(accountId || '').trim();
  if (!initialId) return [];

  if (accountHierarchyCache.has(initialId)) {
    return accountHierarchyCache.get(initialId);
  }

  const hierarchyPromise = (async () => {
    const ids = [];
    const visited = new Set();
    let currentId = initialId;

    // El límite evita ciclos inesperados por datos incorrectos.
    for (let depth = 0; currentId && depth < 30; depth += 1) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      ids.push(currentId);

      const response = await canvas.get(`/accounts/${encodeURIComponent(currentId)}`);
      const parentId = response.data?.parent_account_id;
      currentId = parentId === null || parentId === undefined ? '' : String(parentId);
    }

    return ids;
  })().catch(error => {
    console.warn(`No se pudo consultar la jerarquía de la subcuenta ${initialId}: ${error.message}`);
    return [initialId];
  });

  accountHierarchyCache.set(initialId, hierarchyPromise);
  return hierarchyPromise;
}

async function getCourseDetails(courseId) {
  const normalizedCourseId = String(courseId || '').trim();
  if (!/^\d+$/.test(normalizedCourseId)) {
    throw new Error('El ID del curso debe contener únicamente números.');
  }

  const response = await canvas.get(`/courses/${encodeURIComponent(normalizedCourseId)}`, {
    params: { include: ['term', 'account'] }
  });

  const accountId = response.data.account_id;
  const accountHierarchyIds = await getAccountHierarchyIds(accountId);

  return {
    id: response.data.id,
    name: response.data.name,
    code: response.data.course_code,
    format: response.data.course_format || 'No especificado',
    accountId,
    accountHierarchyIds,
    term: response.data.term || null
  };
}

async function getStudents(courseId) {
  const enrollments = await getAll(`/courses/${courseId}/enrollments`, {
    'type[]': 'StudentEnrollment',
    'state[]': 'active'
  });

  return enrollments.map(enrollment => ({
    canvasId: enrollment.user.id,
    name: enrollment.user.name,
    sortableName: enrollment.user.sortable_name || enrollment.user.name,
    sisUserId: enrollment.user.sis_id || enrollment.sis_user_id || String(enrollment.user.id),
    email: enrollment.user.email || enrollment.user.login_id || ''
  }));
}

async function getModulesForStudent(courseId, studentId) {
  return getAll(`/courses/${courseId}/modules`, {
    'include[]': ['items', 'content_details'],
    student_id: studentId
  });
}

function resolveModuleCloseAt(module) {
  const dueDates = (module.items || [])
    .filter(item => item.completion_requirement)
    .map(item => item.content_details?.due_at)
    .filter(Boolean)
    .map(value => new Date(value))
    .filter(date => !Number.isNaN(date.getTime()));

  if (!dueDates.length) return null;
  return new Date(Math.max(...dueDates.map(date => date.getTime()))).toISOString();
}

function resolveModuleStatus(module, closeAt) {
  const now = Date.now();
  const unlockAt = module.unlock_at ? new Date(module.unlock_at).getTime() : null;
  const closeTime = closeAt ? new Date(closeAt).getTime() : null;

  if (unlockAt && unlockAt > now) return 'future';
  if (closeTime && closeTime < now) return 'closed';
  if (module.state === 'locked') return 'future';
  return 'open';
}

async function generateReportData(courseId, requestedVersion = 'basic', onlyStudentId = null) {
  if (!CANVAS_TOKEN) throw new Error('Falta CANVAS_TOKEN.');

  const course = await getCourseDetails(courseId);
  const version = resolveReportVersion({
    courseId,
    accountId: course.accountId,
    accountIds: course.accountHierarchyIds,
    requestedVersion
  });

  let students = await getStudents(courseId);
  if (onlyStudentId !== null && onlyStudentId !== undefined && String(onlyStudentId).trim()) {
    const userId = String(onlyStudentId);
    students = students.filter(student =>
      String(student.canvasId) === userId || String(student.sisUserId) === userId
    );
  }

  const limit = pLimit(8);
  const studentRows = await Promise.all(
    students.map(student => limit(async () => {
      const modules = await getModulesForStudent(courseId, student.canvasId);
      const moduleProgress = [];
      const moduleDefinitions = [];

      for (const module of modules) {
        if (shouldExcludeModule(module.name)) continue;

        const closeAt = resolveModuleCloseAt(module);
        moduleDefinitions.push({
          id: module.id,
          name: module.name,
          state: module.state || 'unlocked',
          closeAt,
          status: resolveModuleStatus(module, closeAt)
        });

        const requiredItems = (module.items || []).filter(item => Boolean(item.completion_requirement));
        const viewedItems = requiredItems.filter(item => item.completion_requirement?.completed === true).length;
        const totalItems = requiredItems.length;
        const pendingItems = Math.max(totalItems - viewedItems, 0);
        const totalPct = totalItems ? clampPercent((viewedItems / totalItems) * 100) : 0;

        const timing = version === 'pro'
          ? resolveProgressTiming({
              courseId,
              studentId: student.canvasId,
              moduleId: module.id,
              currentPct: totalPct
            })
          : {
              atClose: totalPct,
              afterClose: 0,
              timingAvailable: true,
              timingSource: 'basic-current-total'
            };

        moduleProgress.push({
          moduleId: module.id,
          totalPct,
          atClosePct: timing.atClose,
          afterClosePct: timing.afterClose,
          timingAvailable: timing.timingAvailable,
          timingSource: timing.timingSource,
          viewedItems,
          pendingItems,
          totalItems,
          items: requiredItems.map(item => ({
            id: item.id,
            title: item.title,
            type: item.type,
            completed: item.completion_requirement?.completed === true,
            requirementType: item.completion_requirement?.type || null,
            dueAt: item.content_details?.due_at || null,
            htmlUrl: item.html_url || null
          }))
        });
      }

      return {
        canvasId: student.canvasId,
        sisUserId: student.sisUserId,
        name: student.name,
        sortableName: student.sortableName,
        email: student.email,
        modules: moduleProgress,
        moduleDefinitions
      };
    }))
  );

  const moduleOrder = [];
  const moduleMap = new Map();
  for (const student of studentRows) {
    for (const module of student.moduleDefinitions) {
      const key = String(module.id);
      if (!moduleMap.has(key)) {
        moduleMap.set(key, module);
        moduleOrder.push(key);
      }
    }
    delete student.moduleDefinitions;
  }

  const orderedModules = moduleOrder.map((id, index) => ({
    ...moduleMap.get(id),
    shortName: `Módulo ${index + 1}`
  }));
  const orderedStudents = studentRows.sort((a, b) =>
    String(a.sisUserId).localeCompare(String(b.sisUserId), undefined, { numeric: true })
  );

  return {
    course,
    version,
    modules: orderedModules,
    students: orderedStudents,
    generatedAt: new Date().toISOString()
  };
}

function reportDataToLegacy(data) {
  const summary = [];
  const detail = [];

  for (const student of data.students) {
    const progressByModule = new Map(student.modules.map(item => [String(item.moduleId), item]));

    for (const module of data.modules) {
      const progress = progressByModule.get(String(module.id));
      if (!progress) continue;

      summary.push({
        type: 'summary',
        student_id: student.canvasId,
        student_name: student.name,
        sis_user_id: student.sisUserId,
        module_id: module.id,
        module_name: module.name,
        module_state: module.state,
        module_pct: progress.totalPct,
        module_pct_at_close: progress.atClosePct,
        module_pct_after_close: progress.afterClosePct
      });

      for (const item of progress.items) {
        detail.push({
          type: 'detail',
          student_id: student.canvasId,
          student_name: student.name,
          sis_user_id: student.sisUserId,
          module_id: module.id,
          module_name: module.name,
          item_id: item.id,
          item_title: item.title,
          item_type: item.type,
          requirement_type: item.requirementType,
          completed: item.completed,
          due_at: item.dueAt,
          html_url: item.htmlUrl
        });
      }
    }
  }

  return { summary, detail };
}

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
  '/report',
  '/api/report-data',
  '/api/process-report',
  '/canvas-courses',
  '/course-details',
  '/css',
  '/js',
  '/img'
);

web.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'selector.html'));
});

web.get('/report', async (req, res) => {
  const courseId = req.query.course_id;
  const userId = req.query.user_id;
  const requestedRole = normalizeRole(req.query.role);

  if (!courseId) {
    return res.status(400).send('No se recibió course_id.');
  }

  try {
    const role = userId
      ? await resolveRoleForCourse(courseId, userId, { fallbackRole: requestedRole })
      : requestedRole;

    // Corrige URLs antiguas o manipuladas para que frontend y API utilicen el mismo rol.
    if (role !== requestedRole) {
      const correctedQuery = new URLSearchParams(req.query);
      correctedQuery.set('role', role);
      return res.redirect(`/report?${correctedQuery.toString()}`);
    }

    const course = await getCourseDetails(courseId);
    const version = resolveReportVersion({
      courseId,
      accountId: course.accountId,
      accountIds: course.accountHierarchyIds,
      requestedVersion: req.query.version
    });
    const filename = REPORT_VIEWS[role][version];
    return res.sendFile(path.join(__dirname, 'views', filename));
  } catch (error) {
    console.error('Error resolviendo la vista:', error.message);
    const fallbackVersion = normalizeVersion(req.query.version, 'basic');
    return res.sendFile(path.join(__dirname, 'views', REPORT_VIEWS[requestedRole][fallbackVersion]));
  }
});

web.get('/api/report-data', async (req, res) => {
  const { course_id: courseId, user_id: userId } = req.query;
  const requestedRole = normalizeRole(req.query.role);

  if (!courseId) return res.status(400).json({ error: 'Falta course_id.' });

  try {
    const role = userId
      ? await resolveRoleForCourse(courseId, userId, { fallbackRole: requestedRole })
      : requestedRole;

    if (role === 'student' && !userId) {
      return res.status(400).json({ error: 'Falta user_id para la vista de alumno.' });
    }

    const data = await generateReportData(
      courseId,
      req.query.version,
      role === 'student' ? userId : null
    );
    return res.json(data);
  } catch (error) {
    console.error('Error generando reporte:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// Compatibilidad con el frontend anterior durante la migración.
web.get('/api/process-report', async (req, res) => {
  const { course_id: courseId } = req.query;
  if (!courseId) return res.status(400).json({ error: 'Falta course_id.' });

  try {
    const data = await generateReportData(courseId, req.query.version || 'basic');
    return res.json(reportDataToLegacy(data));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

web.get('/canvas-courses', async (req, res) => {
  try {
    if (!CANVAS_TOKEN) throw new Error('Falta CANVAS_TOKEN.');

    const courses = await getAll('/courses', {
      enrollment_state: 'active',
      'include[]': ['term']
    });

    return res.json({
      success: true,
      total: courses.length,
      cursos: courses.map(course => ({
        id: course.id,
        nombre: course.name,
        codigo: course.course_code,
        account_id: course.account_id
      }))
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

web.get('/course-details', async (req, res) => {
  const courseId = req.query.course_id;
  if (!courseId) return res.status(400).json({ error: 'Falta course_id.' });

  try {
    const course = await getCourseDetails(courseId);
    const version = resolveReportVersion({
      courseId,
      accountId: course.accountId,
      accountIds: course.accountHierarchyIds,
      requestedVersion: req.query.version
    });
    return res.json({ ...course, version });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

(async () => {
  await lti.deploy({ serverless: true, silent: true });

  const platformUrls = [
    PLATFORM_URL,
    'https://iest.beta.instructure.com',
    'https://iest.beta.instructure.com/',
    'https://canvas.instructure.com',
    'https://canvas.instructure.com/',
    'https://canvas.beta.instructure.com',
    'https://canvas.beta.instructure.com/',
    'https://iest.instructure.com',
    'https://iest.instructure.com/'
  ];

  for (const url of platformUrls) {
    if (!url) continue;
    try {
      await lti.registerPlatform({
        url,
        name: 'Canvas Variant',
        clientId: CLIENT_ID,
        authenticationEndpoint: AUTH_LOGIN_URL,
        accesstokenEndpoint: AUTH_TOKEN_URL,
        authConfig: { method: 'JWK_SET', key: KEYSET_URL }
      });
    } catch (error) {
      // La plataforma puede estar previamente registrada.
    }
  }

  lti.onConnect(async (token, req, res) => {
    const customContext = token.platformContext.custom || {};
    const courseId = customContext.canvas_course_id || token.platformContext.context?.id;
    const userId = customContext.canvas_user_id || token.user;
    const roles = token.platformContext.roles || [];

    if (!courseId) return res.status(400).send('No hay contexto de curso.');

    const role = await resolveRoleForCourse(courseId, userId, {
      ltiRoles: roles,
      fallbackRole: 'teacher'
    });

    console.log(`Roles LTI recibidos para curso ${courseId}:`, roles);

    let accountId = null;
    try {
      const course = await getCourseDetails(courseId);
      accountId = course.accountId;
    } catch (error) {
      console.warn('No se pudo consultar account_id durante el launch:', error.message);
    }

    let accountHierarchyIds = [];
    if (accountId) {
      accountHierarchyIds = await getAccountHierarchyIds(accountId);
    }

    const version = resolveReportVersion({ courseId, accountId, accountIds: accountHierarchyIds });
    const query = new URLSearchParams({
      course_id: String(courseId),
      role,
      user_id: String(userId || ''),
      version
    });

    console.log(`Launch LTI | Curso ${courseId} | Usuario ${userId} | Rol ${role} | Versión ${version}`);
    return res.redirect(`/report?${query.toString()}`);
  });

  const host = express();
  host.enable('trust proxy');
  host.use(express.static(path.join(__dirname, 'public')));
  host.use('/', lti.app);

  // Ltijs puede agregar COEP: require-corp mediante su middleware de seguridad.
  // Ese encabezado bloquea reproductores externos como Vimeo dentro del reporte.
  // La aplicación no utiliza funciones que requieran aislamiento entre orígenes,
  // por lo que se elimina antes de entregar las vistas y APIs propias.
  host.use((req, res, next) => {
    res.removeHeader('Cross-Origin-Embedder-Policy');
    next();
  });

  host.use('/', web);

  host.listen(PORT, () => {
    console.log(`Reporte de avance ejecutándose en ${TOOL_URL || `http://localhost:${PORT}`}`);
  });
})().catch(error => {
  console.error('Error al iniciar la aplicación:', error);
  process.exit(1);
});
