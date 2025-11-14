//////////////////////////////////////////////////////////////////////
// File: src/assignentmat/h.ts
// Description: Service to parse and validate Excel files for assigning delivery persons to orders.
//
//Service de parsing Excel
/////////////////////////////////////////////////////////////////////

import { Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { DeliveryPersonAssignmentDto } from '../assign-delivery-person.dto';

@Injectable()
export class DeliveryPersonExcelParserService {
  private readonly logger = new Logger(DeliveryPersonExcelParserService.name);

  parseExcelFile(fileBuffer: Buffer): DeliveryPersonAssignmentDto[] {
    try {
      const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      
      const rows = XLSX.utils.sheet_to_json(worksheet);
      
      const assignments: DeliveryPersonAssignmentDto[] = rows.map((row: any) => ({
        orderNumber: String(row['orderNumber'] || row['Order Number']).trim(),
        deliveryPersonId: String(row['deliveryPersonId'] || row['Delivery Person ID']).trim(),
      }));

      this.logger.log(`Parsed ${assignments.length} assignments from Excel`);
      return assignments;
    } catch (error) {
      this.logger.error(`Failed to parse Excel file: ${error?.message}`);
      throw new Error(`Excel parsing failed: ${error?.message}`);
    }
  }

  validateAssignments(assignments: DeliveryPersonAssignmentDto[]): {
    valid: DeliveryPersonAssignmentDto[];
    invalid: { row: any; reason: string }[];
  } {
    const valid: DeliveryPersonAssignmentDto[] = [];
    const invalid: { row: any; reason: string }[] = [];

    assignments.forEach((assignment, index) => {
      if (!assignment.orderNumber) {
        invalid.push({
          row: index + 1,
          reason: 'Missing orderNumber',
        });
      } else if (!assignment.deliveryPersonId) {
        invalid.push({
          row: index + 1,
          reason: 'Missing deliveryPersonId',
        });
      } else {
        valid.push(assignment);
      }
    });

    return { valid, invalid };
  }
}

///////////////////////////////////////////////////////////////////////
//
//
// Service d'assignation de livreur
///////////////////////////////////////////////////////////////////////

import { Injectable, Logger } from '@nestjs/common';
import { CommercetoolsService } from 'src/commercetools/commercetools.service';
import { CT_CUSTOM_FIELDS } from 'src/constants/commercetools.constants';
import { DeliveryPersonAssignmentDto } from '../dto/assign-delivery-person.dto';
import { DeliveryAssignmentResult } from '../types/delivery-assignment.types';

@Injectable()
export class DeliveryPersonAssignmentService {
  private readonly logger = new Logger(DeliveryPersonAssignmentService.name);

  constructor(private readonly commercetoolsService: CommercetoolsService) {}

  async assignDeliveryPersonToOrder(
    assignment: DeliveryPersonAssignmentDto,
  ): Promise<DeliveryAssignmentResult> {
    try {
      // 1. Récupérer l'order par orderNumber
      const order = await this.commercetoolsService.getOrderByNumber(
        assignment.orderNumber,
      );

      if (!order) {
        return {
          orderNumber: assignment.orderNumber,
          deliveryPersonId: assignment.deliveryPersonId,
          success: false,
          error: `Order not found: ${assignment.orderNumber}`,
        };
      }

      // 2. Mettre à jour les custom fields
      const updatedOrder = await this.commercetoolsService.updateOrderCustomFields(
        order.id,
        order.version,
        {
          [CT_CUSTOM_FIELDS.ORDER.DELIVERY_PERSON_ID]: assignment.deliveryPersonId,
        },
      );

      this.logger.log(
        `Successfully assigned delivery person ${assignment.deliveryPersonId} to order ${assignment.orderNumber}`,
      );

      return {
        orderNumber: assignment.orderNumber,
        deliveryPersonId: assignment.deliveryPersonId,
        success: true,
      };
    } catch (error) {
      this.logger.error(
        `Failed to assign delivery person to order ${assignment.orderNumber}: ${error?.message}`,
      );
      return {
        orderNumber: assignment.orderNumber,
        deliveryPersonId: assignment.deliveryPersonId,
        success: false,
        error: error?.message,
      };
    }
  }

  async assignMultipleDeliveryPersons(
    assignments: DeliveryPersonAssignmentDto[],
  ): Promise<DeliveryAssignmentResult[]> {
    const results: DeliveryAssignmentResult[] = [];

    for (const assignment of assignments) {
      const result = await this.assignDeliveryPersonToOrder(assignment);
      results.push(result);
    }

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    this.logger.warn(
      `Batch assignment completed: ${successCount} success, ${failureCount} failed`,
    );

    return results;
  }
}

///////////////////////////////////////////////////////////////////////
//
//
//  Mettre à jour auto-assignment.service.ts
///////////////////////////////////////////////////////////////////////

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AutoAssignmentEvent } from 'src/constants/events.constants';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob } from 'src/constants/constants';
import { ShopOwnersService } from '../clients/shop-owners/shop-owner.service';
import { ClientsZoneAssignmentService } from './clients-zone-assignment.service';
import { DeliveryPersonExcelParserService } from './services/delivery-person-excel-parser.service';
import { DeliveryPersonAssignmentService } from './services/delivery-person-assignment.service';

@Injectable()
export class AutoAssignmentService {
  private readonly logger = new Logger(AutoAssignmentService.name);

  constructor(
    private readonly shopOwnersService: ShopOwnersService,
    private readonly clientsZoneAssignmentService: ClientsZoneAssignmentService,
    private readonly deliveryPersonExcelParserService: DeliveryPersonExcelParserService,
    private readonly deliveryPersonAssignmentService: DeliveryPersonAssignmentService,
    @InjectQueue(QueueJob.BATCH_CUSTOMERS_ZONES_ASSIGNMENT)
    private readonly queue: Queue,
  ) {}

  // ...existing code...

  async assignDeliveryPersonsFromExcel(fileBuffer: Buffer) {
    try {
      // 1. Parser l'Excel
      const assignments = this.deliveryPersonExcelParserService.parseExcelFile(fileBuffer);

      // 2. Valider les données
      const { valid, invalid } = this.deliveryPersonExcelParserService.validateAssignments(
        assignments,
      );

      if (invalid.length > 0) {
        this.logger.warn(`Found ${invalid.length} invalid rows in Excel file`);
        invalid.forEach((inv) => {
          this.logger.warn(`Row ${inv.row}: ${inv.reason}`);
        });
      }

      // 3. Assigner les livreurs
      const results = await this.deliveryPersonAssignmentService.assignMultipleDeliveryPersons(
        valid,
      );

      return {
        totalProcessed: assignments.length,
        successful: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        details: results,
        invalidRows: invalid,
      };
    } catch (error) {
      this.logger.error(`Failed to process Excel file: ${error?.message}`);
      throw error;
    }
  }
}

///////////////////////////////////////////////////////////////////////
//
//
//  STEP 4A : Contrôleur pour l'upload Excel
///////////////////////////////////////////////////////////////////////

import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AutoAssignmentService } from './auto-assignment.service';

@Controller('auto-assignment')
export class AutoAssignmentController {
  private readonly logger = new Logger(AutoAssignmentController.name);

  constructor(private readonly autoAssignmentService: AutoAssignmentService) {}

  @Post('upload-delivery-assignments')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDeliveryAssignments(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    if (!file.originalname.endsWith('.xlsx') && !file.originalname.endsWith('.xls')) {
      throw new BadRequestException('Only Excel files (.xlsx, .xls) are allowed');
    }

    this.logger.log(`Processing file: ${file.originalname}`);

    const result = await this.autoAssignmentService.assignDeliveryPersonsFromExcel(
      file.buffer,
    );

    return result;
  }
}

///////////////////////////////////////////////////////////////////////
//
//
//  STEP 4B : Mettre à jour le module
///////////////////////////////////////////////////////////////////////

import { Module } from '@nestjs/common';
import { AutoAssignmentService } from './auto-assignment.service';
import { AutoAssignmentController } from './auto-assignment.controller';
import { ClientsZoneAssignmentService } from './clients-zone-assignment.service';
import { DeliveryPersonExcelParserService } from './services/delivery-person-excel-parser.service';
import { DeliveryPersonAssignmentService } from './services/delivery-person-assignment.service';
import { CommercetoolsModule } from 'src/commercetools/commercetools.module';
import { ClientsModule } from 'src/clients/clients.module';

@Module({
  imports: [CommercetoolsModule, ClientsModule],
  providers: [
    AutoAssignmentService,
    ClientsZoneAssignmentService,
    DeliveryPersonExcelParserService,
    DeliveryPersonAssignmentService,
  ],
  controllers: [AutoAssignmentController],
  exports: [AutoAssignmentService, DeliveryPersonAssignmentService],
})
export class AutoAssignmentModule {}


///////////////////////////////////////////////////////////////////////
//
//
//  Tests E2E complets
///////////////////////////////////////////////////////////////////////
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, BadRequestException } from '@nestjs/common';
import * as request from 'supertest';
import * as XLSX from 'xlsx';
import { AutoAssignmentModule } from '../auto-assignment.module';
import { CommercetoolsService } from 'src/commercetools/commercetools.service';
import { DeliveryPersonAssignmentService } from '../services/delivery-person-assignment.service';
import { DeliveryPersonExcelParserService } from '../services/delivery-person-excel-parser.service';

describe('AutoAssignment E2E', () => {
  let app: INestApplication;
  let commercetoolsService: CommercetoolsService;
  let deliveryPersonAssignmentService: DeliveryPersonAssignmentService;
  let excelParserService: DeliveryPersonExcelParserService;

  // Mock data
  const mockCustomer = {
    id: 'customer-123',
    email: 'customer@test.com',
    firstName: 'John',
    lastName: 'Doe',
  };

  const mockDeliveryPerson = {
    id: 'delivery-person-456',
    firstName: 'Jane',
    lastName: 'Smith',
    email: 'jane@test.com',
  };

  const mockOrder = {
    id: 'order-789',
    orderNumber: 'ORD-001',
    version: 1,
    customerId: mockCustomer.id,
    lineItems: [],
    custom: {
      fields: {},
    },
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AutoAssignmentModule],
    })
      .overrideProvider(CommercetoolsService)
      .useValue({
        getOrderByNumber: jest.fn(),
        updateOrderCustomFields: jest.fn(),
        createCustomer: jest.fn(),
        createOrder: jest.fn(),
      })
      .compile();

    app = module.createNestApplication();
    await app.init();

    commercetoolsService = module.get<CommercetoolsService>(CommercetoolsService);
    deliveryPersonAssignmentService = module.get<DeliveryPersonAssignmentService>(
      DeliveryPersonAssignmentService,
    );
    excelParserService = module.get<DeliveryPersonExcelParserService>(
      DeliveryPersonExcelParserService,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /auto-assignment/upload-delivery-assignments', () => {
    it('should reject if no file is uploaded', async () => {
      const response = await request(app.getHttpServer())
        .post('/auto-assignment/upload-delivery-assignments')
        .expect(400);

      expect(response.body.message).toContain('No file uploaded');
    });

    it('should reject non-Excel files', async () => {
      const response = await request(app.getHttpServer())
        .post('/auto-assignment/upload-delivery-assignments')
        .attach('file', Buffer.from('invalid content'), 'test.txt')
        .expect(400);

      expect(response.body.message).toContain('Only Excel files');
    });

    it('should parse valid Excel file and assign delivery persons', async () => {
      // Créer un fichier Excel mock
      const excelData = [
        {
          orderNumber: 'ORD-001',
          deliveryPersonId: 'delivery-person-456',
        },
        {
          orderNumber: 'ORD-002',
          deliveryPersonId: 'delivery-person-789',
        },
      ];

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(excelData);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
      const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

      // Mock les appels Commercetools
      (commercetoolsService.getOrderByNumber as jest.Mock)
        .mockResolvedValueOnce(mockOrder)
        .mockResolvedValueOnce({ ...mockOrder, orderNumber: 'ORD-002', id: 'order-790' });

      (commercetoolsService.updateOrderCustomFields as jest.Mock)
        .mockResolvedValueOnce({ ...mockOrder, custom: { fields: { deliveryPersonId: 'delivery-person-456' } } })
        .mockResolvedValueOnce({ ...mockOrder, orderNumber: 'ORD-002', custom: { fields: { deliveryPersonId: 'delivery-person-789' } } });

      const response = await request(app.getHttpServer())
        .post('/auto-assignment/upload-delivery-assignments')
        .attach('file', excelBuffer, 'assignments.xlsx')
        .expect(200);

      expect(response.body).toEqual({
        totalProcessed: 2,
        successful: 2,
        failed: 0,
        details: expect.arrayContaining([
          expect.objectContaining({
            orderNumber: 'ORD-001',
            deliveryPersonId: 'delivery-person-456',
            success: true,
          }),
          expect.objectContaining({
            orderNumber: 'ORD-002',
            deliveryPersonId: 'delivery-person-789',
            success: true,
          }),
        ]),
        invalidRows: [],
      });
    });

    it('should handle missing orders gracefully', async () => {
      const excelData = [
        {
          orderNumber: 'NON-EXISTENT',
          deliveryPersonId: 'delivery-person-456',
        },
      ];

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(excelData);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
      const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

      (commercetoolsService.getOrderByNumber as jest.Mock).mockResolvedValueOnce(null);

      const response = await request(app.getHttpServer())
        .post('/auto-assignment/upload-delivery-assignments')
        .attach('file', excelBuffer, 'assignments.xlsx')
        .expect(200);

      expect(response.body.successful).toBe(0);
      expect(response.body.failed).toBe(1);
      expect(response.body.details[0].success).toBe(false);
      expect(response.body.details[0].error).toContain('Order not found');
    });

    it('should validate Excel data and report invalid rows', async () => {
      const excelData = [
        {
          orderNumber: 'ORD-001',
          deliveryPersonId: 'delivery-person-456',
        },
        {
          orderNumber: '', // Missing orderNumber
          deliveryPersonId: 'delivery-person-789',
        },
        {
          orderNumber: 'ORD-003',
          deliveryPersonId: '', // Missing deliveryPersonId
        },
      ];

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(excelData);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
      const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

      (commercetoolsService.getOrderByNumber as jest.Mock).mockResolvedValueOnce(mockOrder);
      (commercetoolsService.updateOrderCustomFields as jest.Mock).mockResolvedValueOnce(mockOrder);

      const response = await request(app.getHttpServer())
        .post('/auto-assignment/upload-delivery-assignments')
        .attach('file', excelBuffer, 'assignments.xlsx')
        .expect(200);

      expect(response.body.totalProcessed).toBe(3);
      expect(response.body.successful).toBe(1);
      expect(response.body.failed).toBe(0);
      expect(response.body.invalidRows.length).toBe(2);
      expect(response.body.invalidRows).toContainEqual(
        expect.objectContaining({
          row: 2,
          reason: 'Missing orderNumber',
        }),
      );
      expect(response.body.invalidRows).toContainEqual(
        expect.objectContaining({
          row: 3,
          reason: 'Missing deliveryPersonId',
        }),
      );
    });
  });

  describe('DeliveryPersonAssignmentService', () => {
    it('should assign delivery person to order', async () => {
      (commercetoolsService.getOrderByNumber as jest.Mock).mockResolvedValueOnce(mockOrder);
      (commercetoolsService.updateOrderCustomFields as jest.Mock).mockResolvedValueOnce({
        ...mockOrder,
        custom: { fields: { deliveryPersonId: mockDeliveryPerson.id } },
      });

      const result = await deliveryPersonAssignmentService.assignDeliveryPersonToOrder({
        orderNumber: mockOrder.orderNumber,
        deliveryPersonId: mockDeliveryPerson.id,
      });

      expect(result.success).toBe(true);
      expect(result.orderNumber).toBe(mockOrder.orderNumber);
      expect(result.deliveryPersonId).toBe(mockDeliveryPerson.id);
      expect(commercetoolsService.updateOrderCustomFields).toHaveBeenCalledWith(
        mockOrder.id,
        mockOrder.version,
        { deliveryPersonId: mockDeliveryPerson.id },
      );
    });

    it('should return error when order not found', async () => {
      (commercetoolsService.getOrderByNumber as jest.Mock).mockResolvedValueOnce(null);

      const result = await deliveryPersonAssignmentService.assignDeliveryPersonToOrder({
        orderNumber: 'NON-EXISTENT',
        deliveryPersonId: mockDeliveryPerson.id,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Order not found');
    });
  });

  describe('DeliveryPersonExcelParserService', () => {
    it('should parse valid Excel file', () => {
      const excelData = [
        { orderNumber: 'ORD-001', deliveryPersonId: 'DEL-001' },
        { orderNumber: 'ORD-002', deliveryPersonId: 'DEL-002' },
      ];

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(excelData);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
      const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

      const result = excelParserService.parseExcelFile(excelBuffer);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        orderNumber: 'ORD-001',
        deliveryPersonId: 'DEL-001',
      });
    });

    it('should validate assignments correctly', () => {
      const assignments = [
        { orderNumber: 'ORD-001', deliveryPersonId: 'DEL-001' },
        { orderNumber: '', deliveryPersonId: 'DEL-002' },
        { orderNumber: 'ORD-003', deliveryPersonId: '' },
      ];

      const { valid, invalid } = excelParserService.validateAssignments(assignments);

      expect(valid).toHaveLength(1);
      expect(invalid).toHaveLength(2);
      expect(invalid[0].reason).toBe('Missing orderNumber');
      expect(invalid[1].reason).toBe('Missing deliveryPersonId');
    });
  });
});
///////////////////////////////////////////////////////////////////////
//
//
//  Service pour générer un fichier Excel template
///////////////////////////////////////////////////////////////////////
import { Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';

@Injectable()
export class DeliveryAssignmentTemplateService {
  private readonly logger = new Logger(DeliveryAssignmentTemplateService.name);

  generateTemplate(): Buffer {
    try {
      // Créer les données template
      const templateData = [
        {
          orderNumber: 'ORD-001',
          deliveryPersonId: 'DEL-12345',
        },
        {
          orderNumber: 'ORD-002',
          deliveryPersonId: 'DEL-67890',
        },
        {
          orderNumber: 'ORD-003',
          deliveryPersonId: 'DEL-11111',
        },
      ];

      // Créer le workbook
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(templateData);

      // Ajouter du styling
      worksheet['!cols'] = [{ wch: 20 }, { wch: 20 }];

      XLSX.utils.book_append_sheet(workbook, worksheet, 'Assignments');

      // Générer le buffer
      const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

      this.logger.log('Generated delivery assignment template');
      return buffer;
    } catch (error) {
      this.logger.error(`Failed to generate template: ${error?.message}`);
      throw error;
    }
  }
}
///////////////////////////////////////////////////////////////////////
//
//
//   Mettre à jour le contrôleur avec l'endpoint template
///////////////////////////////////////////////////////////////////////
import {
  Controller,
  Post,
  Get,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Logger,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { AutoAssignmentService } from './auto-assignment.service';
import { DeliveryAssignmentTemplateService } from './services/delivery-assignment-template.service';

@Controller('auto-assignment')
export class AutoAssignmentController {
  private readonly logger = new Logger(AutoAssignmentController.name);

  constructor(
    private readonly autoAssignmentService: AutoAssignmentService,
    private readonly templateService: DeliveryAssignmentTemplateService,
  ) {}

  @Get('download-template')
  downloadTemplate(@Res() res: Response) {
    try {
      const buffer = this.templateService.generateTemplate();

      res.setHeader(
        'Content-Disposition',
        'attachment; filename="delivery-assignments-template.xlsx"',
      );
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.send(buffer);

      this.logger.log('Template downloaded');
    } catch (error) {
      this.logger.error(`Failed to download template: ${error?.message}`);
      throw error;
    }
  }

  @Post('upload-delivery-assignments')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDeliveryAssignments(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    if (!file.originalname.endsWith('.xlsx') && !file.originalname.endsWith('.xls')) {
      throw new BadRequestException('Only Excel files (.xlsx, .xls) are allowed');
    }

    this.logger.log(`Processing file: ${file.originalname}`);

    const result = await this.autoAssignmentService.assignDeliveryPersonsFromExcel(
      file.buffer,
    );

    return result;
  }
}
///////////////////////////////////////////////////////////////////////
//
//
//   Mettre à jour le module
///////////////////////////////////////////////////////////////////////
import { Module } from '@nestjs/common';
import { AutoAssignmentService } from './auto-assignment.service';
import { AutoAssignmentController } from './auto-assignment.controller';
import { ClientsZoneAssignmentService } from './clients-zone-assignment.service';
import { DeliveryPersonExcelParserService } from './services/delivery-person-excel-parser.service';
import { DeliveryPersonAssignmentService } from './services/delivery-person-assignment.service';
import { DeliveryAssignmentTemplateService } from './services/delivery-assignment-template.service';
import { CommercetoolsModule } from 'src/commercetools/commercetools.module';
import { ClientsModule } from 'src/clients/clients.module';

@Module({
  imports: [CommercetoolsModule, ClientsModule],
  providers: [
    AutoAssignmentService,
    ClientsZoneAssignmentService,
    DeliveryPersonExcelParserService,
    DeliveryPersonAssignmentService,
    DeliveryAssignmentTemplateService,
  ],
  controllers: [AutoAssignmentController],
  exports: [
    AutoAssignmentService,
    DeliveryPersonAssignmentService,
    DeliveryAssignmentTemplateService,
  ],
})
export class AutoAssignmentModule {}
///////////////////////////////////////////////////////////////////////
//
//
//   Tests pour le template
///////////////////////////////////////////////////////////////////////
// À ajouter dans : /home/user/Desktop/BackOffice/lbv-atc-ct-backoffice-backend/src/auto-assignment/__tests__/auto-assignment.e2e.spec.ts

describe('GET /auto-assignment/download-template', () => {
  it('should download Excel template', async () => {
    const response = await request(app.getHttpServer())
      .get('/auto-assignment/download-template')
      .expect(200)
      .expect('Content-Type', /spreadsheetml/);

    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-disposition']).toContain(
      'delivery-assignments-template.xlsx',
    );

    // Vérifier que c'est un fichier Excel valide
    const workbook = XLSX.read(response.body, { type: 'buffer' });
    expect(workbook.SheetNames).toContain('Assignments');

    const worksheet = workbook.Sheets['Assignments'];
    const data = XLSX.utils.sheet_to_json(worksheet);

    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('orderNumber');
    expect(data[0]).toHaveProperty('deliveryPersonId');
  });
});