import { CanActivate, ExecutionContext, Injectable, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // Fail closed: an unauthenticated request (AuthGuard not satisfied) must never
    // pass a role check.
    if (!user?.id) {
      throw new ForbiddenException('Authentication required');
    }

    // AuthGuard populates request.user.role from the verified JWT, so the role is
    // read directly from the authenticated principal (no extra DB round-trip).
    const userRole = user.role || 'USER';

    if (!requiredRoles.includes(userRole)) {
      throw new ForbiddenException(`Role ${userRole} is not authorized. Required: ${requiredRoles.join(', ')}`);
    }

    return true;
  }
}
