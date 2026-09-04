import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

const MAX_ADDRESSES_PER_CUSTOMER = 5;

@Injectable()
export class AddressesService {
  constructor(private readonly prisma: PrismaService) {}

  findMine(customerId: string) {
    return this.prisma.customerAddress.findMany({
      where: { customerId },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async create(customerId: string, dto: CreateAddressDto) {
    const existingCount = await this.prisma.customerAddress.count({
      where: { customerId },
    });
    if (existingCount >= MAX_ADDRESSES_PER_CUSTOMER) {
      throw new BadRequestException(
        `You can save up to ${MAX_ADDRESSES_PER_CUSTOMER} delivery addresses. Delete one before adding another.`,
      );
    }

    // The very first address a customer saves becomes their default automatically.
    const makeDefault = dto.isDefault ?? existingCount === 0;
    if (makeDefault) await this.clearDefault(customerId);

    return this.prisma.customerAddress.create({
      data: {
        customerId,
        label: dto.label?.trim(),
        address: dto.address.trim(),
        landmark: dto.landmark?.trim(),
        isDefault: makeDefault,
      },
    });
  }

  async update(customerId: string, id: string, dto: UpdateAddressDto) {
    await this.ensureOwned(customerId, id);

    if (dto.isDefault) await this.clearDefault(customerId);

    return this.prisma.customerAddress.update({
      where: { id },
      data: {
        ...(dto.label !== undefined ? { label: dto.label?.trim() } : {}),
        ...(dto.address !== undefined ? { address: dto.address.trim() } : {}),
        ...(dto.landmark !== undefined ? { landmark: dto.landmark?.trim() } : {}),
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
      },
    });
  }

  async remove(customerId: string, id: string) {
    const address = await this.ensureOwned(customerId, id);
    await this.prisma.customerAddress.delete({ where: { id } });

    // Promote another address to default so the customer never ends up
    // with saved addresses but none marked as their default.
    if (address.isDefault) {
      const next = await this.prisma.customerAddress.findFirst({
        where: { customerId },
        orderBy: { updatedAt: 'desc' },
      });
      if (next) {
        await this.prisma.customerAddress.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }

    return { message: 'Address deleted' };
  }

  private async ensureOwned(customerId: string, id: string) {
    const address = await this.prisma.customerAddress.findFirst({
      where: { id, customerId },
    });
    if (!address) throw new NotFoundException('Address not found');
    return address;
  }

  private clearDefault(customerId: string) {
    return this.prisma.customerAddress.updateMany({
      where: { customerId, isDefault: true },
      data: { isDefault: false },
    });
  }
}
