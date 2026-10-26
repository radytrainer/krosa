import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { API_ENV, type ApiEnv } from '../config/env.js';
import { requestMeta } from '../common/request-meta.js';
import { AuthService } from './auth.service.js';
import type { AuthUser } from './auth.types.js';
import {
  ACCESS_COOKIE,
  clearSessionCookies,
  CSRF_HEADER,
  readCookie,
  REFRESH_COOKIE,
  setSessionCookies,
} from './cookies.js';
import {
  AllowWhenPasswordChangeRequired,
  Authenticated,
  CurrentUser,
  Public,
  SkipCsrfToken,
} from './decorators.js';
import { ChangePasswordDto, LoginDto, type MeResponse } from './dto.js';
import { TokenService } from './token.service.js';
import { Throttle } from '../common/throttle.js';

function csrfHeader(req: Request): string | undefined {
  const value = req.headers[CSRF_HEADER];
  return typeof value === 'string' ? value : undefined;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Signed in; session cookies set' })
  @ApiUnauthorizedResponse({ description: 'INVALID_CREDENTIALS' })
  @ApiForbiddenResponse({
    description: 'ACCOUNT_DISABLED / ACCOUNT_PENDING / TEMPORARY_PASSWORD_EXPIRED',
  })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED / ACCOUNT_LOCKED' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: MeResponse }> {
    const { session, me } = await this.auth.login(dto, requestMeta(req));
    setSessionCookies(res, this.env, session);
    return { user: me };
  }

  @Post('refresh')
  @Throttle({ bucket: 'refresh', perIp: { limit: 30, windowSeconds: 60 } })
  @Public()
  @SkipCsrfToken()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Tokens rotated; new cookies set' })
  @ApiUnauthorizedResponse({ description: 'Session expired, revoked or refresh token reused' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    try {
      const session = await this.auth.refresh(
        readCookie(req.cookies, REFRESH_COOKIE),
        csrfHeader(req),
        requestMeta(req),
      );
      setSessionCookies(res, this.env, session);
    } catch (err) {
      // A failed refresh ends the browser session, except for CSRF failures: those requests
      // are likely forged, and clearing cookies would let an attacker log the victim out.
      if (!(err instanceof HttpException && err.getStatus() === HttpStatus.FORBIDDEN)) {
        clearSessionCookies(res, this.env);
      }
      throw err;
    }
  }

  @Post('logout')
  @Public()
  @SkipCsrfToken()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Session revoked and cookies cleared' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(
      {
        access: readCookie(req.cookies, ACCESS_COOKIE),
        refresh: readCookie(req.cookies, REFRESH_COOKIE),
        csrf: csrfHeader(req),
      },
      requestMeta(req),
    );
    clearSessionCookies(res, this.env);
  }

  @Post('change-password')
  @Authenticated()
  @AllowWhenPasswordChangeRequired()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth()
  @ApiNoContentResponse({ description: 'Password changed; other sessions revoked' })
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const updated = await this.auth.changePassword(user, dto, requestMeta(req));
    // Re-issue the access token so the cleared must-change flag takes effect immediately.
    const accessToken = await this.tokens.signAccessToken({
      ...user,
      mustChangePassword: updated.mustChangePassword,
    });
    setSessionCookies(res, this.env, { accessToken });
  }

  @Get('me')
  @Authenticated()
  @AllowWhenPasswordChangeRequired()
  @ApiCookieAuth()
  @ApiOkResponse({ description: 'The signed-in user' })
  me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    return this.auth.me(user.userId);
  }
}
