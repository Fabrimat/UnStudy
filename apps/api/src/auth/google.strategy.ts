import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy } from 'passport-google-oauth20';
import { config } from '../config';
import { AuthService } from './auth.service';
import { cookieStateStore } from './oauth-state';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(private auth: AuthService) {
    super({
      clientID: config.google!.clientId,
      clientSecret: config.google!.clientSecret,
      callbackURL: config.google!.callbackUrl,
      scope: ['email', 'profile'],
      // Binds /api/auth/google to its callback via a short-lived cookie (no express-session in this app).
      store: cookieStateStore('oauth_state', '/api/auth/google'),
    });
  }

  async validate(_accessToken: string, _refreshToken: string, profile: Profile) {
    const email = profile.emails?.[0];
    if (!email) throw new UnauthorizedException('Google account has no email');
    return this.auth.loginWithProvider('google', profile.id, email.value, email.verified === true);
  }
}
