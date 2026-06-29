import { OpenAPIV3 } from 'openapi-types';

/**
 * OpenAPI/Swagger specification for Yasmin AI API
 * This defines the API documentation that will be served at /api-docs
 */
export const openApiSpec: OpenAPIV3.Document = {
  openapi: '3.0.3'
  info: {
    title: 'Yasmin AI API'
    description: 'AI assistant API for thomsen.in - Powered by Mistral AI'
    version: '0.1.0'
    contact: {
      name: 'Christopher Thomsen'
      url: 'https://thomsen.in'
    }
    license: {
      name: 'Private'
    }
  }
  servers: [
    {
      url: 'http://localhost:5000'
      description: 'Local development server'
    }
    {
      url: 'https://api.thomsen.in'
      description: 'Production server'
    }
  ]
  tags: [
    {
      name: 'Chat'
      description: 'Chat endpoints for different interaction types'
    }
    {
      name: 'Health'
      description: 'Health check and monitoring endpoints'
    }
  ]
  paths: {
    '/health': {
      get: {
        tags: ['Health']
        summary: 'Health check endpoint'
        description: 'Returns the current health status of the API service'
        operationId: 'getHealth'
        responses: {
          '200': {
            description: 'Service is healthy'
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/HealthResponse'
                }
                example: {
                  status: 'healthy'
                  timestamp: '2024-01-15T10:30:00.000Z'
                  version: '0.1.0'
                  uptime: 1234.56
                  requestId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
                }
              }
            }
          }
        }
      }
    }
    '/chat/bot': {
      post: {
        tags: ['Chat']
        summary: 'Bot chat endpoint'
        description: 'Process a chat message from a bot conversation'
        operationId: 'postBotChat'
        security: [
          {
            bearerAuth: []
          }
        ]
        requestBody: {
          required: true
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/SynologyRequest'
              }
              example: {
                text: 'Hello, how are you?'
                token: 'CHAT_TOKEN_BOT'
                user_id: 12345
                username: 'john_doe'
              }
            }
            'application/x-www-form-urlencoded': {
              schema: {
                $ref: '#/components/schemas/SynologyRequest'
              }
            }
          }
        }
        responses: {
          '202': {
            description: 'Request accepted, response will be sent asynchronously to Synology Chat'
          }
          '400': {
            description: 'Invalid request body'
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
          '401': {
            description: 'Unauthorized - Invalid or missing token'
          }
          '429': {
            description: 'Too many requests - Rate limit exceeded'
          }
          '500': {
            description: 'Internal server error'
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
        }
      }
    }
    '/chat/slash': {
      post: {
        tags: ['Chat']
        summary: 'Slash command endpoint'
        description: 'Process a slash command message (e.g., /yasmin hello)'
        operationId: 'postSlashChat'
        security: [
          {
            bearerAuth: []
          }
        ]
        requestBody: {
          required: true
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/SynologyRequest'
              }
              example: {
                text: '/yasmin What is the weather today?'
                token: 'CHAT_TOKEN_SLASH'
                user_id: 12345
                username: 'john_doe'
              }
            }
            'application/x-www-form-urlencoded': {
              schema: {
                $ref: '#/components/schemas/SynologyRequest'
              }
            }
          }
        }
        responses: {
          '200': {
            description: 'Synchronous response with the AI answer'
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/SlashResponse'
                }
                example: {
                  text: 'The weather in Berlin is sunny today!'
                }
              }
            }
          }
          '400': {
            description: 'Invalid request body'
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
          '401': {
            description: 'Unauthorized - Invalid or missing token'
          }
          '429': {
            description: 'Too many requests - Rate limit exceeded'
          }
          '500': {
            description: 'Internal server error'
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
        }
      }
    }
    '/chat/group': {
      post: {
        tags: ['Chat']
        summary: 'Group chat endpoint'
        description: 'Process a chat message from a group conversation'
        operationId: 'postGroupChat'
        security: [
          {
            bearerAuth: []
          }
        ]
        requestBody: {
          required: true
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/SynologyRequest'
              }
              example: {
                text: 'Hello everyone!'
                token: 'CHAT_TOKEN_GROUP'
                user_id: 12345
                username: 'john_doe'
              }
            }
            'application/x-www-form-urlencoded': {
              schema: {
                $ref: '#/components/schemas/SynologyRequest'
              }
            }
          }
        }
        responses: {
          '200': {
            description: 'Synchronous response with the AI answer'
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/SlashResponse'
                }
                example: {
                  text: 'Hello everyone! How can I help you?'
                }
              }
            }
          }
          '400': {
            description: 'Invalid request body'
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
          '401': {
            description: 'Unauthorized - Invalid or missing token'
          }
          '429': {
            description: 'Too many requests - Rate limit exceeded'
          }
          '500': {
            description: 'Internal server error'
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
        }
      }
    }
  }
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http'
        scheme: 'bearer'
        bearerFormat: 'token'
        description: 'Synology Chat token for authentication'
      }
    }
    schemas: {
      SynologyRequest: {
        type: 'object'
        required: ['text', 'token', 'user_id', 'username']
        properties: {
          text: {
            type: 'string'
            description: 'The message text from the user'
            minLength: 1
            maxLength: 10000
            example: 'Hello, how are you?'
          }
          token: {
            type: 'string'
            description: 'Authentication token for the specific endpoint (bot, slash, or group)'
            minLength: 1
          }
          user_id: {
            type: 'integer'
            description: 'Unique identifier for the user'
            minimum: 1
            example: 12345
          }
          username: {
            type: 'string'
            description: 'Username of the sender'
            minLength: 1
            maxLength: 100
            pattern: '^[a-zA-Z0-9_-]+$'
            example: 'john_doe'
          }
          post_id: {
            type: 'integer'
            description: 'Optional post identifier'
            minimum: 1
            example: 67890
          }
          thread_id: {
            type: 'integer'
            description: 'Optional thread identifier'
            minimum: 1
            example: 11111
          }
          timestamp: {
            type: 'integer'
            description: 'Optional timestamp of the message'
            minimum: 1
            example: 1719652800
          }
        }
      }
      SlashResponse: {
        type: 'object'
        required: ['text']
        properties: {
          text: {
            type: 'string'
            description: 'The AI-generated response text'
            example: 'Hello! How can I help you today?'
          }
        }
      }
      HealthResponse: {
        type: 'object'
        required: ['status', 'timestamp', 'version', 'uptime']
        properties: {
          status: {
            type: 'string'
            description: 'Health status of the service'
            enum: ['healthy', 'unhealthy', 'degraded']
            example: 'healthy'
          }
          timestamp: {
            type: 'string'
            format: 'date-time'
            description: 'Current timestamp'
            example: '2024-01-15T10:30:00.000Z'
          }
          version: {
            type: 'string'
            description: 'API version'
            example: '0.1.0'
          }
          uptime: {
            type: 'number'
            description: 'Uptime in seconds'
            example: 1234.56
          }
          requestId: {
            type: 'string'
            description: 'Unique request identifier'
            example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
          }
        }
      }
      ErrorResponse: {
        type: 'object'
        required: ['error']
        properties: {
          error: {
            type: 'string'
            description: 'Error message'
            example: 'Invalid request body'
          }
        }
      }
    }
  }
  externalDocs: {
    description: 'Find out more about Yasmin AI'
    url: 'https://thomsen.in'
  }
};
