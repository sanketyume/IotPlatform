import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import { LogContext, LogLevel } from '../types';

class Logger {
  private static instance: Logger;
  private logger: winston.Logger;
  private correlationIdEnabled: boolean;

  private constructor() {
    const loggingConfig = config.getLoggingConfig();
    this.correlationIdEnabled = loggingConfig.correlationIdEnabled;

    const formats: winston.Logform.Format[] = [winston.format.timestamp()];

    if (loggingConfig.format === 'json') {
      formats.push(winston.format.json());
    } else {
      formats.push(
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
          return `${timestamp} [${level.toUpperCase()}]: ${message} ${metaStr}`;
        }),
      );
    }

    this.logger = winston.createLogger({
      level: loggingConfig.level,
      format: winston.format.combine(...formats),
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
        }),
        new DailyRotateFile({
          dirname: loggingConfig.outputDir,
          filename: 'mqtt-broker-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '14d',
          level: 'info',
        }),
        new DailyRotateFile({
          dirname: loggingConfig.outputDir,
          filename: 'mqtt-broker-error-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '30d',
          level: 'error',
        }),
      ],
    });
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  generateCorrelationId(): string {
    return uuidv4();
  }

  private formatContext(context?: LogContext): Record<string, unknown> {
    if (!context) {
      return this.correlationIdEnabled ? { correlationId: this.generateCorrelationId() } : {};
    }

    if (this.correlationIdEnabled && !context.correlationId) {
      context.correlationId = this.generateCorrelationId();
    }

    return context as Record<string, unknown>;
  }

  error(message: string, context?: LogContext): void {
    this.logger.error(message, this.formatContext(context));
  }

  warn(message: string, context?: LogContext): void {
    this.logger.warn(message, this.formatContext(context));
  }

  info(message: string, context?: LogContext): void {
    this.logger.info(message, this.formatContext(context));
  }

  debug(message: string, context?: LogContext): void {
    this.logger.debug(message, this.formatContext(context));
  }

  log(level: LogLevel, message: string, context?: LogContext): void {
    this.logger.log(level, message, this.formatContext(context));
  }

  child(defaultContext: LogContext): Logger {
    const childLogger = Object.create(this);
    childLogger.logger = this.logger.child(this.formatContext(defaultContext));
    return childLogger;
  }
}

export default Logger.getInstance();
