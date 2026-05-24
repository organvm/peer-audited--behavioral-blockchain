import { RoleGuard } from './role.guard';
import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';

describe('RoleGuard', () => {
  let guard: RoleGuard;
  let mockReflector: Reflector;

  beforeEach(() => {
    mockReflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as Reflector;
    guard = new RoleGuard(mockReflector);
  });

  function createContext(user: { id: string; role?: string } | null, handler = jest.fn(), cls = jest.fn()) {
    return {
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as any;
  }

  it('should allow access when no roles are required', () => {
    (mockReflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);

    const result = guard.canActivate(createContext({ id: 'u1' }));

    expect(result).toBe(true);
  });

  it('should allow access when empty roles array', () => {
    (mockReflector.getAllAndOverride as jest.Mock).mockReturnValue([]);

    const result = guard.canActivate(createContext({ id: 'u1' }));

    expect(result).toBe(true);
  });

  it('should throw ForbiddenException when user has no id (fail closed)', () => {
    (mockReflector.getAllAndOverride as jest.Mock).mockReturnValue(['ADMIN']);

    expect(() => guard.canActivate(createContext(null))).toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException when user role does not match', () => {
    (mockReflector.getAllAndOverride as jest.Mock).mockReturnValue(['ADMIN']);

    expect(() => guard.canActivate(createContext({ id: 'u-regular', role: 'USER' }))).toThrow(
      /Role USER is not authorized/,
    );
  });

  it('should allow access when user role matches', () => {
    (mockReflector.getAllAndOverride as jest.Mock).mockReturnValue(['ADMIN']);

    const result = guard.canActivate(createContext({ id: 'u-admin', role: 'ADMIN' }));

    expect(result).toBe(true);
  });

  it('should allow access when user role matches one of multiple required roles', () => {
    (mockReflector.getAllAndOverride as jest.Mock).mockReturnValue(['ADMIN', 'FURY']);

    const result = guard.canActivate(createContext({ id: 'u-fury', role: 'FURY' }));

    expect(result).toBe(true);
  });

  it('should default to USER role when role field is absent', () => {
    (mockReflector.getAllAndOverride as jest.Mock).mockReturnValue(['ADMIN']);

    expect(() => guard.canActivate(createContext({ id: 'u-null-role' }))).toThrow(
      /Role USER is not authorized/,
    );
  });
});
