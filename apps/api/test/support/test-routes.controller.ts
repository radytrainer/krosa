import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Authenticated, CurrentUser, Roles } from '../../src/auth/decorators.js';
import type { AuthUser } from '../../src/auth/auth.types.js';

/** Routes that exist only in tests, to exercise the global guards. */
@Controller('test')
export class TestRoutesController {
  @Get('admin')
  @Roles('ADMIN')
  admin() {
    return { ok: true };
  }

  @Get('student')
  @Roles('STUDENT')
  student(@CurrentUser() user: AuthUser) {
    return { ok: true, userId: user.userId };
  }

  @Get('any')
  @Authenticated()
  any() {
    return { ok: true };
  }

  /** Deliberately missing an access policy: must be denied. */
  @Get('unannotated')
  unannotated() {
    return { ok: true };
  }

  @Post('mutate')
  @Authenticated()
  @HttpCode(200)
  mutate() {
    return { ok: true };
  }
}
