import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@summarize/db';
import { PrismaService } from '../prisma.service';
import { CreateLabPresetDto } from './admin.dto';

@Injectable()
export class LabPresetsService {
  constructor(private prisma: PrismaService) {}

  list() {
    return this.prisma.labPreset.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, judge: true, lanes: true } });
  }

  async create(dto: CreateLabPresetDto) {
    try {
      const lanes = dto.lanes.map((l) => ({ draft: l.draft, verify: l.verify, ...(l.harness && { harness: true }) }));
      return await this.prisma.labPreset.create({
        data: { name: dto.name, judge: dto.judge ?? null, lanes },
        select: { id: true, name: true, judge: true, lanes: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('A preset with this name already exists');
      throw e;
    }
  }

  async remove(id: string) {
    try {
      await this.prisma.labPreset.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw new NotFoundException('Preset not found');
      throw e;
    }
  }
}
