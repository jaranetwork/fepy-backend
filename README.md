# FEPY Backend - Sistema de Facturación Electrónica SIFEN

Proyecto backend del sistema de facturación electrónica para Paraguay (SIFEN) con procesamiento asíncrono mediante colas de trabajo.

## 📋 Descripción

API RESTful para generar XML-KUDE, firmar xml, insertar QR y enviar facturas electrónicas a la SET (Superintendencia de Tributación) bajo el sistema SIFEN.

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
POST /api/facturar/crear
Authorization: Bearer <API_KEY>

{
  "param": {
    "version": 150,
    "ruc": "3604076-1",
    "razonSocial": "EMPRESA DE PRUEBA S.A.",
    "nombreFantasia": "EMPRESA TEST",
    "actividadesEconomicas": [{
      "codigo": "1254",
      "descripcion": "Desarrollo de Software"
    }],
    "timbradoNumero": "12558946",
    "timbradoFecha": "2022-08-25",
    "tipoContribuyente": 2,
    "tipoRegimen": 8,
    "establecimientos": [{
      "codigo": "001",
      "denominacion": "MATRIZ",
      "direccion": "Barrio Carolina",
      "numeroCasa": "0",
      "complementoDireccion1": "Entre calle 2",
      "complementoDireccion2": "y Calle 7",
      "departamento": 11,
      "departamentoDescripcion": "ALTO PARANA",
      "distrito": 145,
      "distritoDescripcion": "CIUDAD DEL ESTE",
      "ciudad": 3432,
      "ciudadDescripcion": "PUERTO PTE.STROESSNER (MUNIC)",
      "telefono": "0973-527155",
      "email": "test@empresa.com.py"
    }]
  },
  
  "data": {
    "tipoDocumento": 1,
    "establecimiento": "001",
    "punto": "001",
    "numero": "000002",
    "codigoSeguridadAleatorio": "987654322",
    "descripcion": "Factura electrónica de prueba",
    "observacion": "Sin valor comercial ni fiscal - Solo para pruebas",
    "fecha": "2026-02-27T10:00:00",
    "tipoEmision": 1,
    "tipoTransaccion": 1,
    "tipoImpuesto": 1,
    "moneda": "PYG",
    "condicionAnticipo": 1,
    "condicionTipoCambio": 1,
    "descuentoGlobal": 0,
    "anticipoGlobal": 0,
    "cambio": 6700,
    
    "cliente": {
      "contribuyente": true,
      "ruc": "44444-1",
      "razonSocial": "CLIENTE DE PRUEBA S.A.",
      "nombreFantasia": "CLIENTE TEST",
      "tipoOperacion": 1,
      "direccion": "Av. Principal",
      "numeroCasa": "123",
      "complementoDireccion1": "Entre calles A y B",
      "departamento": 1,
      "departamentoDescripcion": "ASUNCION",
      "distrito": 1,
      "distritoDescripcion": "ASUNCION",
      "ciudad": 1,
      "ciudadDescripcion": "ASUNCION",
      "pais": "PRY",
      "paisDescripcion": "Paraguay",
      "tipoContribuyente": 1,
      "documentoTipo": 1,
      "documentoNumero": "44444",
      "telefono": "021-123456",
      "celular": "0981-123456",
      "email": "cliente@test.com"
    },
    
    "usuario": {
      "documentoTipo": 1,
      "documentoNumero": "123456",
      "nombre": "Vendedor Test",
      "cargo": "Vendedor"
    },
    
    "factura": {
      "presencia": 1,
      "fechaEnvio": "2026-02-27T18:00:00"
    },
    
    "condicion": {
      "tipo": 1,
      "entregas": [{
        "tipo": 1,
        "monto": "1000",
        "moneda": "PYG",
        "cambio": 0
      }]
    },
    
    "items": [{
      "codigo": "PROD-001",
      "descripcion": "Producto de prueba",
      "observacion": "Producto sin valor comercial - Solo testing",
      "unidadMedida": 77,
      "cantidad": 1,
      "precioUnitario": 909.09,
      "cambio": 0,
      "descuento": 0,
      "anticipo": 0,
      "pais": "PRY",
      "paisDescripcion": "Paraguay",
      "ivaTipo": 1,
      "ivaProporcion": 100,
      "iva": 10
    }],
    
    "totalPago": 1000
  }
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

### Desarrollo (Mock-SET)

```bash
# .env
SIFEN_USAR_MOCK=true
SIFEN_MOCK_URL=http://localhost:8082
```
```javascript
// El código usa automáticamente el mock
const setApi = require('./services/setapi-wrapper');
await setApi.recibe(id, xml, 'test', certPath, password);
```

### Producción (SET Real)

```bash
# .env
SIFEN_USAR_MOCK=false
SIFEN_AMBIENTE=test  # o 'prod'
```

```javascript
// El código usa automáticamente la SET real
const setApi = require('./services/setapi-wrapper');
await setApi.recibe(id, xml, 'test', certPath, password);
```
## 📋 Variables de Entorno

| Variable | Descripción | Valores | Default |
|----------|-------------|---------|---------|
| `SIFEN_USAR_MOCK` | Usar Mock-SET en lugar de SET Real | `true` \| `false` | `false` |
| `SIFEN_MOCK_URL` | URL del servidor Mock-SET | URL válida | `http://localhost:8082` |

## 📊 Estados de una Factura

| Estado | Descripción |
|--------|-------------|
| `encolado` | Recibido, esperando procesamiento |
| `procesando` | Worker está generando XML, firmando, enviando a SET |
| `aceptado` | SET aprobó la factura (CDC generado) |
| `rechazado` | SET rechazó la factura |
| `error` | Error en el proceso |

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

1. Crear API Key desde el frontend
2. Incluir en headers: `Authorization: Bearer <API_KEY>`
3. Las API Keys pueden estar asociadas a una empresa específica

## Proyectos

- [FEPY frontend](https://github.com/jaranetwork/fepy-frontend) Interface web
- [Módulo ERPNext](https://github.com/jaranetwork/einvoice) para el envío de facturas a FEPY

## 📚 Recursos

- [Manual Técnico SIFEN v150](https://www.set.gov.py)
- [Documentación de Bull](https://docs.bullmq.io/)
- [Redis Documentation](https://redis.io/documentation)

## 📚 Librerías de código abierto

- [facturacionelectronicapy-xmlgen](https://github.com/TIPS-SA/facturacionelectronicapy-xmlgen)
- [facturacionelectronicapy-xmlsign](https://github.com/marcosjara/facturacionelectronicapy-xmlsign)
- [facturacionelectronicapy-qrgen](https://github.com/marcosjara/facturacionelectronicapy-qrgen)
- [facturacionelectronicapy-kude](https://github.com/marcosjara/facturacionelectronicapy-kude)
- [facturacionelectronicapy-setapi](https://github.com/marcosjara/facturacionelectronicapy-setapi)

## 📄 Licencia

MIT

## 👥 Autores

Jara Network
