# FEPY Backend - Sistema de Facturación Electrónica SIFEN

Proyecto backend del sistema de facturación electrónica para Paraguay (SIFEN) con procesamiento asíncrono mediante colas de trabajo.

## 📋 Descripción

API RESTful para generar, firmar y enviar facturas electrónicas a la SET (Superintendencia de Tributación) bajo el sistema SIFEN.

**Características principales:**
- ✅ Procesamiento asíncrono con colas (Bull + Redis)
- ✅ Multi-empresa (cada empresa con su propia configuración SIFEN)
- ✅ Firma digital de XML con certificados .p12
- ✅ Reintentos automáticos en caso de error

## 🏗️ Arquitectura

```
┌──────────┐      ┌─────────────┐      ┌──────────────┐
│  Cliente │─────▶│   Backend   │─────▶│    Redis     │
│  (API)   │      │  (Express)  │      │   (Bull)     │
└──────────┘      └─────────────┘      └──────┬───────┘
                                              │
                    ┌─────────────────────────┘
                    ▼
             ┌─────────────┐
             │   Worker    │
             │ (Procesador)│
             └─────────────┘
```

## 🚀 Inicio Rápido

### Prerrequisitos

- Node.js 14+
- MongoDB 4.4.30+
- Redis 7.0+
- Java 8+ (para generación de KUDE/PDF)

### Instalación

```bash
# Clonar repositorio
git clone https://github.com/jaranetwork/fepy-backend.git
cd fepy-backend

# Instalar dependencias
npm install

# Aplicar parches a librerías
node patch-kude.js

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales
```

### Ejecución

```bash
# Iniciar Redis (si no está corriendo)
redis-server --daemonize yes

# Iniciar backend + worker juntos
npm run start:all

# O por separado:
# Terminal 1 - Backend
npm start

# Terminal 2 - Worker
npm run worker
```

## 📡 Endpoints Principales

### Enviar Factura (Asíncrono)

```bash
POST /get_einvoice
Authorization: Bearer <API_KEY>

{
  "ruc": "8001234-5",
  "numero": "0000060",
  "cliente": {
    "razonSocial": "Cliente S.A.",
    "ruc": "44444-1",
    ...
  },
  "items": [...],
  "totalPago": 1000
}
```

**Respuesta (202 Accepted):**
```json
{
  "success": true,
  "message": "Factura encolada para procesamiento asíncrono",
  "data": {
    "facturaId": "65f1234567890abcdef12345",
    "correlativo": "001-001-0000060",
    "estado": "encolado",
    "jobId": "factura-65f1234567890abcdef12345"
  }
}
```

### Consultar Estado

```bash
GET /api/factura/estado/:id
```

### Estadísticas de la Cola

```bash
GET /api/queue/stats
```

## 🔧 Configuración

### Variables de Entorno (.env)

```bash
# Servidor
PORT=8081
NODE_ENV=development

# MongoDB
MONGODB_URI=mongodb://localhost:27017/sifen_db

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Mock SET (desarrollo) simulador de servidor
MOCK_DEBUG=true
MOCK_SET_URL=http://localhost:8082
```

## 📊 Estados de una Factura

| Estado | Descripción |
|--------|-------------|
| `encolado` | Recibido, esperando procesamiento |
| `procesando` | Worker está generando XML, firmando, enviando a SET |
| `aceptado` | SET aprobó la factura (CDC generado) |
| `rechazado` | SET rechazó la factura |
| `error` | Error en el proceso |

## 🧪 Testing

### Test de Carga

```bash
# Enviar 5 facturas simultáneas
./test-queue.sh
```

### Test Manual con cURL

```bash
# Enviar factura
curl -X POST http://localhost:8081/get_einvoice \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{"ruc":"8001234-5","numero":"0000060",...}'

# Consultar estado
curl http://localhost:8081/api/factura/estado/<ID>

# Ver cola
curl http://localhost:8081/api/queue/stats | jq .
```

## 📁 Estructura del Proyecto

```
fepy-backend/
├── server.js                 # Servidor principal
├── package.json
├── patch-kude.js            # Parche para librería KUDE
├── models/
│   ├── Invoice.js           # Modelo de factura
│   ├── Empresa.js           # Modelo de empresa (multi-tenant)
│   ├── ApiKey.js            # Modelo de API Keys
│   ├── User.js              # Modelo de usuario
│   └── OperationLog.js      # Log de operaciones
├── routes/
│   ├── get_einvoice.js      # Endpoint principal
│   ├── invoices.js          # Rutas de facturas
│   ├── empresas.js          # Rutas de empresas
│   └── stats.js             # Estadísticas
├── controllers/
│   ├── authController.js    # Autenticación
│   ├── apiKeyController.js  # Gestión de API Keys
│   └── empresaController.js # CRUD de empresas
├── services/
│   ├── procesarFacturaService.js  # Lógica de facturación
│   └── certificadoService.js      # Gestión de certificados
├── workers/
│   └── facturaWorker.js     # Procesador asíncrono
├── queues/
│   └── facturaQueue.js      # Configuración de colas
├── middleware/
│   └── auth.js              # Autenticación JWT
└── certificados/
    └── :ruc/
        └── certificado.p12  # Certificados por empresa
```

## 🔐 Autenticación

El sistema usa **API Keys** para autenticación:

1. Crear API Key desde el frontend o directamente en BD
2. Incluir en headers: `Authorization: Bearer <API_KEY>`
3. Las API Keys pueden estar asociadas a una empresa específica

## 📈 Performance

| Escenario | Requests | Tiempo Respuesta |
|-----------|----------|------------------|
| 1 usuario | 1 | ~50ms (inmediato) |
| 10 usuarios | 10 | ~50ms c/u |
| 100 usuarios | 100 | ~50ms c/u |

**Ventajas vs. Síncrono:**
- No bloquea el hilo principal
- Reintentos automáticos
- Escalable horizontalmente (más workers)

## 🛠️ Comandos Útiles

```bash
# Ver logs del worker
tail -f logs/worker.log

# Ver cola de Redis
redis-cli
> LLEN bull:facturacion:wait
> LLEN bull:facturacion:active

# Reintentar jobs fallidos
node -e "
const { facturaQueue } = require('./queues/facturaQueue');
(async () => {
  const jobs = await facturaQueue.getFailed();
  jobs.forEach(job => job.retry());
  process.exit(0);
})();
"

# Limpiar cola de completados
node -e "
const { cleanCompletedJobs } = require('./queues/facturaQueue');
(async () => {
  const { facturaQueue } = require('./queues/facturaQueue');
  await cleanCompletedJobs(facturaQueue, 100);
  process.exit(0);
})();
"
```

## 📚 Recursos

- [Manual Técnico SIFEN v150](https://www.set.gov.py)
- [Documentación de Bull](https://docs.bullmq.io/)
- [Redis Documentation](https://redis.io/documentation)

## 📚 Librerias de código abierto

- [facturacionelectronicapy-xmlgen](https://github.com/TIPS-SA/facturacionelectronicapy-xmlgen)
- [facturacionelectronicapy-xmlsign](https://github.com/marcosjara/facturacionelectronicapy-xmlsign)
- [facturacionelectronicapy-qrgen](https://github.com/marcosjara/facturacionelectronicapy-qrgen)
- [facturacionelectronicapy-kude](https://github.com/marcosjara/facturacionelectronicapy-kude)
- [facturacionelectronicapy-setapi](https://github.com/marcosjara/facturacionelectronicapy-setapi)

## 📄 Licencia

MIT

## 👥 Autores

Jara Network
