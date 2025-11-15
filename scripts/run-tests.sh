#!/bin/bash

# Run specific test suites for MQTT module verification

set -e

COLOR_BLUE='\033[0;34m'
COLOR_GREEN='\033[0;32m'
COLOR_RESET='\033[0m'

show_usage() {
    echo "Usage: $0 [test-suite]"
    echo ""
    echo "Test Suites:"
    echo "  clustering    - Broker clustering and failover tests"
    echo "  security      - Security and ACL tests"
    echo "  pipeline      - Data pipeline tests"
    echo "  performance   - Performance benchmark tests"
    echo "  monitoring    - Monitoring and metrics tests"
    echo "  all           - Run all tests (default)"
    echo ""
}

run_test_suite() {
    local suite=$1
    echo -e "${COLOR_BLUE}Running $suite tests...${COLOR_RESET}"

    case $suite in
        clustering)
            npm test -- tests/integration/broker-clustering.test.ts
            ;;
        security)
            npm test -- tests/integration/security.test.ts
            ;;
        pipeline)
            npm test -- tests/integration/data-pipeline.test.ts
            ;;
        performance)
            npm test -- tests/performance/benchmark.test.ts --testTimeout=300000
            ;;
        monitoring)
            npm test -- tests/integration/monitoring.test.ts
            ;;
        all)
            npm test
            ;;
        *)
            echo "Unknown test suite: $suite"
            show_usage
            exit 1
            ;;
    esac

    if [ $? -eq 0 ]; then
        echo -e "${COLOR_GREEN}✓ $suite tests passed${COLOR_RESET}"
    else
        echo -e "${COLOR_RED}✗ $suite tests failed${COLOR_RESET}"
        exit 1
    fi
}

# Main
SUITE=${1:-all}

echo -e "${COLOR_BLUE}========================================${COLOR_RESET}"
echo -e "${COLOR_BLUE}MQTT Module Test Runner${COLOR_RESET}"
echo -e "${COLOR_BLUE}========================================${COLOR_RESET}"
echo ""

if [ "$SUITE" = "help" ] || [ "$SUITE" = "-h" ] || [ "$SUITE" = "--help" ]; then
    show_usage
    exit 0
fi

run_test_suite "$SUITE"

echo ""
echo -e "${COLOR_GREEN}All tests completed successfully!${COLOR_RESET}"
