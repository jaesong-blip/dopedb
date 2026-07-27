//! Focused Cloud SQL connect-settings parser characterization.

use serde_json::json;

use crate::connection::GcpCloudSqlNetworkMode;
use crate::model::Engine;

use super::gcp_target::parse_connect_settings;

const CA: &str = "-----BEGIN CERTIFICATE-----\nMIIC2DCCAcCgAwIBAgIJAPjwG8eYzM+eMA0GCSqGSIb3DQEBCwUAMBkxFzAVBgNV\nBAMMDmRvcGVkYi10ZXN0LWNhMB4XDTI2MDcyNzAzNTAyOVoXDTI2MDcyOTAzNTAy\nOVowGTEXMBUGA1UEAwwOZG9wZWRiLXRlc3QtY2EwggEiMA0GCSqGSIb3DQEBAQUA\nA4IBDwAwggEKAoIBAQDuzf/pBbfyFEWl2Nkf4GMr+Qlt8RxcRn4cZUzkc0Xdd3qP\nLo4ERigWfFGVtJP3znTTHkJ4oGKEAdXWuKkgvoFD1fNSL50FIVhoRz7642l87aOw\nddG3Tmt/MlI9aTwC7MLucqliptIwBR0JwKB2/rUq6OTsn71d3elnhXL8CF2p31iX\nqJasHZWwZuttK36vYwZkYjC6tM7GIm6YWo53oVLV4DOGDMwh1q0KRAuastMLkFXo\ndLsH8qYaXryG8YVWurk5p4H8rxOGxU3ybljniIsFI5HXe6GLIJPWliA0L60sS36U\nxWOCbKe0Zz5DCwKYz4Vq1T4ZNKn47+W53baIst/vAgMBAAGjIzAhMA8GA1UdEwEB\n/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMA0GCSqGSIb3DQEBCwUAA4IBAQArB494\n51yySOx0KVnK3zUOehyNhkRw4CHX4MjobenKZ9xNmwpRgkGqRc7aU91mSxjCygXV\ncqVgjA48/VvRwDKVl66wtO6kFO2F7bn4LFPIaJZpiybbqdjNMnA/4SSTcAAZ0yry\nnls2I/bX4EPleiAdhMB2ylaUobHZ+R/oJ5+6pMx9l6xqCnTtZl0ggnhYguTeUAxL\nv7dCh+c4kiVHzyYf8WNzk6OrRj4GiAa+vlQJtN6qQ/Z6KrOYkjtciUQcnCZlnJzI\nqTTkeqKvdvnH6I3F/lyMwQ/9hRhyT52HHRCvsiuZlLaYCjGK73wdFEOxEj7uwyYh\njzweC8S8vind2pr9\n-----END CERTIFICATE-----";
const LEAF: &str = "-----BEGIN CERTIFICATE-----\nMIICzzCCAbegAwIBAgIJAJIGY8sEs0djMA0GCSqGSIb3DQEBCwUAMBYxFDASBgNV\nBAMMC2RvcGVkYi1sZWFmMB4XDTI2MDcyNzAzNTAzNFoXDTI2MDcyOTAzNTAzNFow\nFjEUMBIGA1UEAwwLZG9wZWRiLWxlYWYwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAw\nggEKAoIBAQDUtIJrCvEwtCbMINhx7hzlRyq88CNKfK1qVx6vM4P5Cpwsq5u28ymF\nZP1QrurTqT5wL8//g8l2qe/Zslub11P1vWZ0PS1FTuQL4V+bF+qfr617L7jrlBNp\nyf63auMhrKF+w+wYUQdXy50wJy7FSsfqNkMHBZQbzxHm8S6k2Q5uTCdm3gkZ5NTb\nkYqcVnZj7uz6d5IfNB+0Ft+ZjxfNHzPHn09nogWLysQl3gQxLeacyZoQsTLY4K4J\nBleRxyNBKa2hhOqNbBcZnOeDL8uFTcAdJwWXP10p8YGp9GkiBTm8Fy7nbxkh8kM/\n7q00vT8jZTcB9NrA05/kxW2DIWkdi4fVAgMBAAGjIDAeMAwGA1UdEwEB/wQCMAAw\nDgYDVR0PAQH/BAQDAgeAMA0GCSqGSIb3DQEBCwUAA4IBAQBXzbsuStk1hoh677YS\nFCQ2uncZxYBiIcB9vVNM+460c0scdgmOEP1JvX8XJQthywRVlaCw8PYM5dMaK3aV\n+clCMisFs/5ESZM6L2gWabfuH54WspxS0iQQm92svA/+hoQMbSpmuXn6ar0yPcbX\nvIFjCz8EYIx6L1fn3uE8HI2CA7ApFodMhxAAMbz0FQ6lZTwNAwYR2ZRr12bp3+8K\nz7M8n+dE5WvCsZLYiYP9zITmCGAt8dbkcEqhaLZCp64YPkvpKVs06erDG5veYFre\nGGMmJ+vBJEMtXECKuvEzwZLFHPPVQmOcc4JlhrzMLo1cIgOLQN84dp/DMALtPA2R\nxCAj\n-----END CERTIFICATE-----";
const CA_WITHOUT_KEY_CERT_SIGN: &str = "-----BEGIN CERTIFICATE-----\nMIIC2DCCAcCgAwIBAgIJANtupWQPO99QMA0GCSqGSIb3DQEBCwUAMCExHzAdBgNV\nBAMMFmRvcGVkYi1jYS1uby1rZXktdXNhZ2UwHhcNMjYwNzI3MDM1MDM1WhcNMjYw\nNzI5MDM1MDM1WjAhMR8wHQYDVQQDDBZkb3BlZGItY2Etbm8ta2V5LXVzYWdlMIIB\nIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4YLatAvvorWwkCqTAoLjW8yi\nNPBE9asn77PB6owMsmRbzx5hKs8NwVqGr7LrX51CIqwnmeecILjRJOrfyen6gS+4\nWDzwX9G9nYEJeB25Nb2WxxnwDbFetVF1ERALo7LT3+lBDqbaC3U6mHOdY9xh7WPk\n2NhlKhzra3edjLSUon31nUjiX9xBAwv+wjbD//Ax1bYQ03Ni+Adypjd5eDHm+Ber\n7jpRj4cqrFPkVaZbrI9yPYRolrBn7BgR3KFWqwrH45fSuD9uKaPBoAnqc4C0PRe6\naiBlxpKex9uau7bz/ZYALxq+/Byi+7bPUVeRTb3ZA+KNqrCdryzTvc1u4+xBgwID\nAQABoxMwETAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAU1H4N\nUTTtTgapgtsEdHn5Mad5tpksbZvS4pj9rtYxii+RVh2qEgNkFirAm52x6aeMCV+Q\nHWruJ0efE2WY8hBFL0SXdCZYftbBHwXQVMGQbUMsNKiVO/7GeVyU4t+Y3+UWxZyb\nRhR06BHBGvOBPHrWhiJu5FQAZNo3iOQSezGp+pWNVrNFKOXJdtWmrNGfdJ02YZz9\nLn1CP+knQQ1ryFTXuebkojZ6X0CC90Eu9mGiKiom1dgKqlbcsbqrH/8wfA1rmwLI\nf3yG7oXcEVvzLNP6thmM4X/1BqkZZYMsPAqr1NY95Nqmhi4BIYhTCdXlYtxmHUGM\nZQtjDdQo5/UCvmFy\n-----END CERTIFICATE-----";
const CA_WITH_INVALID_KEY_USAGE: &str = "-----BEGIN CERTIFICATE-----\nMIIC8jCCAdqgAwIBAgIJAJCkY7PZPAi0MA0GCSqGSIb3DQEBCwUAMCYxJDAiBgNV\nBAMMG2RvcGVkYi1jYS1pbnZhbGlkLWtleS11c2FnZTAeFw0yNjA3MjcwMzU5Mjda\nFw0yNjA3MjkwMzU5MjdaMCYxJDAiBgNVBAMMG2RvcGVkYi1jYS1pbnZhbGlkLWtl\neS11c2FnZTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMJwDwQ2G7kI\ni3NgoqrxIshfDU+Ir6FWajNMVWcwFMpjRfzDlXQS9hh/XUBMod9wFaosHUQyGZl5\nL5h9Mv7m7synaD043G2+LTGlBG8jhYKCvGc5rMXjqX6BlaVo9zeuk/bM3gAhR1A8\nwbKsPi2PdGBh7RimsU7tXTqtkEl9efyygXp4Srz9641fvYt/eeMIXkemvgE8G2Bt\nbDqebHXo70b099o9W6JYibhXsXCEY5tqMti7NCyVT9bJ2hWHVM01nlmyn0ahOHPL\n2bTDDLBNDP0Z5qMlCIjQX2wdP6OOSMMEFPB5pf7T2QwxPQRTrOesm10aeC07wN08\nYS7nq/Un3D0CAwEAAaMjMCEwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC\nB4AwDQYJKoZIhvcNAQELBQADggEBAI9F+6uSmfsPgkf8x3xK3KWHR4QlzZlH3HyX\nNGJAIxEAdDcC+7l2JM7C/H9yg5TXsmDejCT5w15EJmg7+uhJzULBcGAr4MVnO45W\ngj8OXUmWYSoeES9OkS9AHiJu0R69oRFWlp319wcwSdURgiebtmvPJFq9qWxMfh34\nWWL94G6FpbvVGFijrIGfUpF6HIl4Cv54pz0FHI/YTEde26Lttm7GE8d5UY04bjmb\nss6DyhUA9GigWW3KlruQfRafiDU1Q0Y9s0Fqot3CS75PZ15zkh9E39c4FketJ0li\n4r0rEulkyZwmIeiKM7lpG3bKPeshEIin/uMV0cKWhgBiHbk9/JI=\n-----END CERTIFICATE-----";
const WITHOUT_BASIC_CONSTRAINTS: &str = "-----BEGIN CERTIFICATE-----\nMIICyDCCAbACCQD8hYwEbRRZSDANBgkqhkiG9w0BAQsFADAmMSQwIgYDVQQDDBtk\nb3BlZGItbm8tYmFzaWMtY29uc3RyYWludHMwHhcNMjYwNzI3MDM1OTQwWhcNMjYw\nNzI5MDM1OTQwWjAmMSQwIgYDVQQDDBtkb3BlZGItbm8tYmFzaWMtY29uc3RyYWlu\ndHMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDN53bADTTY7vYQcVEo\nkyDuMHFOgf3l2m7mLYokzYeAiOwg2lf/jH7TSjNEiTGb+Uj82Zt7fSXaUoQhSkt+\nDkmRtb830EtoAoXY+mupbmw60RGiqqmEZNDSw4XBnTU2IrgURqpDyleGcGPbsuI1\nn4fGDKF79GV+f0pCi+kezLjiFgDsNXIKZlYB78c9C3ep9ZvxB+ZIwyk6bOD2zixG\nlrlTHCXZCkgb/k7VYHttZ6WndHSsE+wO0gCRle7STER46P47sZgjJyVozQy06g7k\n1CafNcWA4FcNsDS1SCn9pcHPgoGgV3rANg8RuXJfeeCHmZBZ0koqy+MjuJQdHM3C\nFG9DAgMBAAEwDQYJKoZIhvcNAQELBQADggEBAKOEcX+0Y/6tkyULfn39EdL3Ywcs\nFFHLo/kdOSC1Qai8b8QYhHNyy/vldKlKBYzMCrzx7c1TrXexyJjICrYH99kNbGnX\nVpwpZOJNXvC0ZRDMyXDa0h3tRfjN6a9Yv50e1dUAHqWnfc9hHKfQoXBrWXaBj7SV\nTRyP2YPT+gHg6e2hB5+afKxBRg3Q2udnnM8AHYCDwiUjEkKrrwvZxCg8w7wJG8ho\nXR206iCCJqnzxlbI5tGeVG/6GMGbJ8wyoRU5DDfNZeDn72wsWNMnK1n4n7KzqQQ7\nTKrJZAngtiQle5Yyk4ytfGSW+ZZ6h0MNVB0rH5zFIAwiPSnCcvu9KQV0Zlk=\n-----END CERTIFICATE-----";

fn response() -> serde_json::Value {
    json!({"databaseVersion":"POSTGRES_16","serverCaCert":{"cert":CA},"ipAddresses":[{"type":"PRIMARY","ipAddress":"8.8.8.8"},{"type":"PRIVATE","ipAddress":"10.0.0.12"}],"pscEnabled":true,"dnsName":"instance-one.region.sql.goog"})
}

#[test]
fn connect_settings_selects_only_the_declared_network_mode_and_tls_shape() {
    let body = serde_json::to_vec(&response()).unwrap();
    let public =
        parse_connect_settings(Engine::Postgres, GcpCloudSqlNetworkMode::Public, &body).unwrap();
    assert_eq!(public.host, "8.8.8.8");
    assert_eq!(public.sslmode, "verify-ca");
    let psc = parse_connect_settings(
        Engine::Postgres,
        GcpCloudSqlNetworkMode::PrivateServiceConnect,
        &body,
    )
    .unwrap();
    assert_eq!(psc.host, "instance-one.region.sql.goog");
    assert_eq!(psc.sslmode, "verify-full");
}

#[test]
fn connect_settings_rejects_target_ca_and_network_injection() {
    for body in [
        json!({"databaseVersion":"POSTGRES_16","serverCaCert":{"cert":"not-a-pem"},"ipAddresses":[{"type":"PRIMARY","ipAddress":"8.8.8.8"}]}),
        json!({"databaseVersion":"POSTGRES_16","serverCaCert":{"cert":CA},"pscEnabled":true,"dnsName":"user@evil.example"}),
        json!({"databaseVersion":"POSTGRES_16","serverCaCert":{"cert":format!("{CA}junk")},"ipAddresses":[{"type":"PRIMARY","ipAddress":"8.8.8.8"}]}),
        json!({"databaseVersion":"POSTGRES_16","serverCaCert":{"cert":CA},"ipAddresses":[{"type":"PRIMARY","ipAddress":"203.0.113.12"}]}),
        json!({"databaseVersion":"POSTGRES_16","serverCaCert":{"cert":LEAF},"ipAddresses":[{"type":"PRIMARY","ipAddress":"8.8.8.8"}]}),
        json!({"databaseVersion":"POSTGRES_16","serverCaCert":{"cert":CA_WITHOUT_KEY_CERT_SIGN},"ipAddresses":[{"type":"PRIMARY","ipAddress":"8.8.8.8"}]}),
        json!({"databaseVersion":"POSTGRES_16","serverCaCert":{"cert":CA_WITH_INVALID_KEY_USAGE},"ipAddresses":[{"type":"PRIMARY","ipAddress":"8.8.8.8"}]}),
        json!({"databaseVersion":"POSTGRES_16","serverCaCert":{"cert":WITHOUT_BASIC_CONSTRAINTS},"ipAddresses":[{"type":"PRIMARY","ipAddress":"8.8.8.8"}]}),
        json!({"databaseVersion":"POSTGRES_16","serverCaCert":{"cert":format!("{CA}\n{CA}")},"ipAddresses":[{"type":"PRIMARY","ipAddress":"8.8.8.8"}]}),
    ] {
        assert!(parse_connect_settings(
            Engine::Postgres,
            GcpCloudSqlNetworkMode::Public,
            &serde_json::to_vec(&body).unwrap()
        )
        .is_err());
    }
}

#[test]
fn psc_accepts_only_official_dns_suffix_and_one_trailing_dot() {
    let mut body = response();
    body["dnsName"] = json!("instance-one.region.sql-psc.goog.");
    assert_eq!(
        parse_connect_settings(
            Engine::Postgres,
            GcpCloudSqlNetworkMode::PrivateServiceConnect,
            &serde_json::to_vec(&body).unwrap()
        )
        .unwrap()
        .host,
        "instance-one.region.sql-psc.goog"
    );
    body["dnsName"] = json!("instance-one.evil.example");
    assert!(parse_connect_settings(
        Engine::Postgres,
        GcpCloudSqlNetworkMode::PrivateServiceConnect,
        &serde_json::to_vec(&body).unwrap()
    )
    .is_err());
}
