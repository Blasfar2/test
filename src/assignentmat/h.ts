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

